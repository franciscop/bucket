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
  IBucketFile,
  FileInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";

export interface GCSObjectMeta {
  name: string;
  contentType: string;
  size: string;
  updated: string;
  mediaLink: string;
}

export type GCSAuth = { clientEmail: string; privateKey: string } | null;

export class GCSFile implements IBucketFile {
  id: string;
  name: string;
  path: string;
  #bucket: string;
  #authPromise: Promise<GCSAuth>;
  #endpoint: string;
  #anonymous: boolean;

  constructor(
    path: string,
    bucket: string,
    authPromise: Promise<GCSAuth>,
    endpoint: string = "https://storage.googleapis.com",
    anonymous: boolean = false,
  ) {
    this.path = path.startsWith("/") ? path.slice(1) : path;
    this.name = this.path.split("/").pop() || this.path;
    this.id = this.path;
    this.#bucket = bucket;
    this.#authPromise = authPromise;
    this.#endpoint = endpoint;
    this.#anonymous = anonymous;
  }

  #apiUrl(): string {
    return `${this.#endpoint}/storage/v1/b/${this.#bucket}/o/${encodeURIComponent(this.path)}`;
  }

  #mediaUrl(): string {
    return `${this.#apiUrl()}?alt=media`;
  }

  async #headers(
    extra: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    // Emulators (fake-gcs-server) accept unauthenticated requests.
    if (this.#anonymous) return { ...extra };
    const auth = await this.#authPromise;
    const token = auth ? await getAccessToken(auth) : await getMetadataToken();
    return { Authorization: `Bearer ${token}`, ...extra };
  }

  async info(): Promise<FileInfo> {
    const res = await fetch(this.#apiUrl(), { headers: await this.#headers() });
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
    const hasMeta =
      options.cacheControl || options.disposition || options.metadata;

    if (hasMeta) {
      const boundary = `_b_${Date.now()}`;
      const metaObj: Record<string, unknown> = { name: this.path };
      if (type) metaObj.contentType = type;
      if (options.cacheControl) metaObj.cacheControl = options.cacheControl;
      if (options.disposition) metaObj.contentDisposition = options.disposition;
      if (options.metadata) metaObj.metadata = options.metadata;

      const metaJson = JSON.stringify(metaObj);
      const contentType = type ?? "application/octet-stream";
      const dataBuffer = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as string);
      const prefix = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
      );
      const suffix = Buffer.from(`\r\n--${boundary}--`);
      const body = Buffer.concat([prefix, dataBuffer, suffix]);

      const url = `${this.#endpoint}/upload/storage/v1/b/${this.#bucket}/o?uploadType=multipart`;
      const res = await fetch(url, {
        method: "POST",
        headers: await this.#headers({
          "Content-Type": `multipart/related; boundary=${boundary}`,
        }),
        body,
      });
      if (!res.ok) throw new Error(`GCS PUT error: ${res.status}`);
    } else {
      const url = `${this.#endpoint}/upload/storage/v1/b/${this.#bucket}/o?uploadType=media&name=${encodeURIComponent(this.path)}`;
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
    const url = `${this.#endpoint}/storage/v1/b/${this.#bucket}/o/${encodeURIComponent(this.path)}/copyTo/b/${this.#bucket}/o/${encodeURIComponent(dst)}`;
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
      throw new Error("rename() cannot change directory, use moveTo() instead");
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
    return `${this.#endpoint}/${this.#bucket}/${this.path}`;
  }

  async signedUrl(opts: { expires: number | string }): Promise<string | null> {
    const auth = await this.#authPromise;
    if (!auth) return null;
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
