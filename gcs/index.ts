import "dotenv/config";

import { Readable, Writable } from "node:stream";
import parse from "../lib/parse.ts";
import promiseToReadable from "../lib/promiseToReadable.ts";
import promiseToWritable from "../lib/promiseToWritable.ts";
import {
  getAccessToken,
  getMetadataToken,
  presignGCS,
} from "../lib/signGCS.ts";
import { getContentType } from "../lib/fileTypes.ts";
import type {
  BucketInfo,
  FileInfo,
  IBucket,
  IBucketFile,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";

const { GCS_BUCKET: ENV_BUCKET } = process.env;

interface GCSObjectMeta {
  name: string;
  contentType: string;
  size: string;
  updated: string;
  mediaLink: string;
}

type GCSAuth = { clientEmail: string; privateKey: string } | null; // null = use metadata server

async function loadAuth(): Promise<GCSAuth> {
  // Service account or google credentials (`gcloud auth application-default login`)
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath) {
    const { readFileSync } = await import("node:fs");
    const json = JSON.parse(readFileSync(credPath, "utf-8")) as {
      client_email: string;
      private_key: string;
    };
    const clientEmail = json.client_email ?? "";
    const privateKey = json.private_key?.replace(/\\n/g, "\n");
    return { clientEmail, privateKey };
  }

  // Individual environment variables — some platforms (Vercel, Railway, etc.)
  const clientEmail = process.env.GCS_CLIENT_EMAIL;
  const privateKey = process.env.GCS_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (clientEmail && privateKey) {
    return { clientEmail, privateKey };
  }

  // GCP metadata server — Cloud Run, GKE, Compute Engine, etc.
  return null;
}

class GCSFile implements IBucketFile {
  id: string;
  name: string;
  path: string;
  #bucket: string;
  #authPromise: Promise<GCSAuth>;

  constructor(path: string, bucket: string, authPromise: Promise<GCSAuth>) {
    this.path = path.startsWith("/") ? path.slice(1) : path;
    this.name = this.path.split("/").pop() || this.path;
    this.id = this.path;
    this.#bucket = bucket;
    this.#authPromise = authPromise;
  }

  #apiUrl(): string {
    return `https://storage.googleapis.com/storage/v1/b/${this.#bucket}/o/${encodeURIComponent(this.path)}`;
  }

  #mediaUrl(): string {
    return `${this.#apiUrl()}?alt=media`;
  }

  async #headers(
    extra: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const auth = await this.#authPromise;
    const token = auth ? await getAccessToken(auth) : await getMetadataToken();
    return { Authorization: `Bearer ${token}`, ...extra };
  }

  async info(): Promise<FileInfo> {
    const res = await fetch(this.#apiUrl(), {
      headers: await this.#headers(),
    });
    if (res.status === 404) {
      return {
        id: this.id,
        name: this.name,
        path: this.path,
        exists: false,
        type: null,
        size: 0,
        date: null,
        url: null,
      };
    }
    if (!res.ok) throw new Error(`GCS info error: ${res.status}`);
    const meta = (await res.json()) as GCSObjectMeta;
    return {
      id: this.id,
      name: this.name,
      path: this.path,
      exists: true,
      type: meta.contentType,
      size: parseInt(meta.size, 10),
      date: new Date(meta.updated),
      url: this.publicUrl(),
    };
  }

  async exists(): Promise<boolean> {
    return (await this.info()).exists;
  }

  async text(): Promise<string> {
    const res = await fetch(this.#mediaUrl(), {
      headers: await this.#headers(),
    });
    if (!res.ok) throw new Error(`GCS GET error: ${res.status}`);
    return res.text();
  }

  async json(): Promise<unknown> {
    const res = await fetch(this.#mediaUrl(), {
      headers: await this.#headers(),
    });
    if (!res.ok) throw new Error(`GCS GET error: ${res.status}`);
    return res.json();
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const res = await fetch(this.#mediaUrl(), {
      headers: await this.#headers(),
    });
    if (!res.ok) throw new Error(`GCS GET error: ${res.status}`);
    return res.arrayBuffer();
  }

  async blob(): Promise<Blob> {
    const res = await fetch(this.#mediaUrl(), {
      headers: await this.#headers(),
    });
    if (!res.ok) throw new Error(`GCS GET error: ${res.status}`);
    return res.blob();
  }

  async bytes(): Promise<Uint8Array> {
    return new Uint8Array(await this.arrayBuffer());
  }

  async #put(data: string | Buffer, options: WriteOptions = {}): Promise<void> {
    const type = options.type ?? getContentType(this.path);
    const hasMeta = options.cacheControl || options.disposition || options.metadata;

    if (hasMeta) {
      // Multipart upload: sets content-type and metadata in one request
      const boundary = `_b_${Date.now()}`;
      const metaObj: Record<string, unknown> = { name: this.path };
      if (type) metaObj.contentType = type;
      if (options.cacheControl) metaObj.cacheControl = options.cacheControl;
      if (options.disposition) metaObj.contentDisposition = options.disposition;
      if (options.metadata) metaObj.metadata = options.metadata;

      const metaJson = JSON.stringify(metaObj);
      const contentType = type ?? "application/octet-stream";
      const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data as string);
      const prefix = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
      );
      const suffix = Buffer.from(`\r\n--${boundary}--`);
      const body = Buffer.concat([prefix, dataBuffer, suffix]);

      const url = `https://storage.googleapis.com/upload/storage/v1/b/${this.#bucket}/o?uploadType=multipart`;
      const res = await fetch(url, {
        method: "POST",
        headers: await this.#headers({
          "Content-Type": `multipart/related; boundary=${boundary}`,
        }),
        body,
      });
      if (!res.ok) throw new Error(`GCS PUT error: ${res.status}`);
    } else {
      // Simple media upload
      const url = `https://storage.googleapis.com/upload/storage/v1/b/${this.#bucket}/o?uploadType=media&name=${encodeURIComponent(this.path)}`;
      const extra: Record<string, string> = {};
      if (type) extra["Content-Type"] = type;
      const res = await fetch(url, {
        method: "POST",
        headers: await this.#headers(extra),
        body: data as BodyInit,
      });
      if (!res.ok) throw new Error(`GCS PUT error: ${res.status}`);
    }
  }

  async write(content: WriteContent, options?: WriteOptions): Promise<void> {
    if (typeof content === "string") return this.#put(content, options);
    if (content instanceof Buffer || content instanceof Uint8Array)
      return this.#put(Buffer.from(content), options);
    if (content instanceof Blob)
      return this.#put(Buffer.from(await content.arrayBuffer()), options);
    if (content instanceof GCSFile)
      return this.#put(Buffer.from(await content.arrayBuffer()), options);
    if (typeof (content as ReadableStream).pipeTo === "function")
      return (content as ReadableStream).pipeTo(this.writable(options));
    if (content instanceof Readable)
      return Readable.toWeb(content).pipeTo(this.writable(options));
    throw new Error("Invalid content type");
  }

  async copyTo(path: string): Promise<void> {
    const dst = path.startsWith("/") ? path.slice(1) : path;
    const url = `https://storage.googleapis.com/storage/v1/b/${this.#bucket}/o/${encodeURIComponent(this.path)}/copyTo/b/${this.#bucket}/o/${encodeURIComponent(dst)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: await this.#headers(),
    });
    if (!res.ok) throw new Error(`GCS COPY error: ${res.status}`);
  }

  async moveTo(path: string): Promise<void> {
    await this.copyTo(path);
    await this.remove();
  }

  async rename(name: string): Promise<void> {
    if (name.includes("/"))
      throw new Error(
        "rename() cannot change directory — use moveTo() instead",
      );
    const dir = this.path.split("/").slice(0, -1).join("/");
    await this.moveTo(dir ? dir + "/" + name : name);
  }

  async remove(): Promise<void> {
    const res = await fetch(this.#apiUrl(), {
      method: "DELETE",
      headers: await this.#headers(),
    });
    if (!res.ok && res.status !== 204)
      throw new Error(`GCS DELETE error: ${res.status}`);
  }

  stream(): ReadableStream {
    return promiseToReadable(async () => {
      const res = await fetch(this.#mediaUrl(), {
        headers: await this.#headers(),
      });
      if (!res.ok) throw new Error(`GCS GET error: ${res.status}`);
      return res.body!;
    });
  }

  nodeReadable(): NodeJS.ReadableStream {
    return Readable.fromWeb(
      this.stream() as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
    );
  }

  writable(options?: WriteOptions): WritableStream {
    return promiseToWritable((data: Buffer) => this.#put(data, options));
  }

  nodeWritable(options?: WriteOptions): NodeJS.WritableStream {
    return Writable.fromWeb(
      this.writable(options) as unknown as WritableStream<Uint8Array>,
    );
  }

  publicUrl(): string {
    return `https://storage.googleapis.com/${this.#bucket}/${this.path}`;
  }

  async signedUrl(opts: { expires: number | string }): Promise<string | null> {
    const auth = await this.#authPromise;
    if (!auth) return null; // metadata server auth cannot sign URLs
    const seconds = parse(opts.expires) ?? 3600;
    return presignGCS(this.#bucket, this.path, auth, "GET", seconds);
  }

  async uploadUrl(opts: { expires: number | string }): Promise<string | null> {
    const auth = await this.#authPromise;
    if (!auth) return null;
    const seconds = parse(opts.expires) ?? 3600;
    return presignGCS(this.#bucket, this.path, auth, "PUT", seconds);
  }
}

class GCSBucket implements IBucket {
  readonly type = "GCS";
  #bucket: string;
  #authPromise: Promise<GCSAuth>;
  #cachedToken: string | null = null;
  #tokenExpiry = 0;

  constructor(bucket: string) {
    this.#bucket = bucket;
    this.#authPromise = loadAuth();
  }

  async accessToken(): Promise<string> {
    if (this.#cachedToken && Date.now() < this.#tokenExpiry) {
      return this.#cachedToken;
    }
    const auth = await this.#authPromise;
    this.#cachedToken = auth
      ? await getAccessToken(auth)
      : await getMetadataToken();
    this.#tokenExpiry = Date.now() + 55 * 60 * 1000; // 55 min (tokens last 1h)
    return this.#cachedToken!;
  }

  async info(): Promise<BucketInfo> {
    return {
      id: this.#bucket,
      name: this.#bucket,
      type: this.type,
      endpoint: `https://storage.googleapis.com/${this.#bucket}`,
    };
  }

  async list(filter?: string | RegExp): Promise<GCSFile[]> {
    const files: GCSFile[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({ maxResults: "1000" });
      if (typeof filter === "string" && filter) params.set("prefix", filter);
      if (pageToken) params.set("pageToken", pageToken);

      const token = await this.accessToken();
      const res = await fetch(
        `https://storage.googleapis.com/storage/v1/b/${this.#bucket}/o?${params}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`GCS list error: ${res.status}`);

      const data = (await res.json()) as {
        items?: GCSObjectMeta[];
        nextPageToken?: string;
      };

      for (const item of data.items ?? []) {
        if (filter instanceof RegExp && !filter.test(item.name)) continue;
        files.push(new GCSFile(item.name, this.#bucket, this.#authPromise));
      }

      pageToken = data.nextPageToken;
    } while (pageToken);

    return files;
  }

  file(name: string): GCSFile {
    if (!name) throw new Error("No name");
    return new GCSFile(name, this.#bucket, this.#authPromise);
  }

  async remove(filter?: string | RegExp): Promise<GCSFile[]> {
    const files = await this.list(filter);
    await Promise.all(files.map((f) => f.remove()));
    return files;
  }

  async count(filter?: string | RegExp): Promise<number> {
    return (await this.list(filter)).length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<GCSFile> {
    for (const file of await this.list()) yield file;
  }
}

/**
 * Create a Google Cloud Storage bucket handle.
 *
 * @param bucket - Bucket name (falls back to `GCS_BUCKET` env var)
 *
 * Credentials are resolved in order:
 * 1. `GOOGLE_APPLICATION_CREDENTIALS` env var → reads the JSON file it points to
 * 2. `GCS_CLIENT_EMAIL` + `GCS_PRIVATE_KEY` env vars
 * 3. GCP metadata server (automatic on Cloud Run, GKE, Compute Engine, etc.)
 *
 * @example
 * const bucket = GCS("my-bucket");
 * await bucket.file("hello.txt").write("hello");
 */
export default function GCS(bucket: string = ENV_BUCKET || ""): GCSBucket {
  return new GCSBucket(bucket);
}

export { GCSBucket, GCSFile };
