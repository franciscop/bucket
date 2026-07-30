import { Readable, Writable } from "node:stream";
import parse from "../lib/parse.ts";
import promiseToReadable from "../lib/promiseToReadable.ts";
import chunkedWritable, {
  writeChunked,
  type ChunkedTarget,
} from "../lib/chunkedWritable.ts";
import {
  getAccessToken,
  getMetadataToken,
  presignGCS,
} from "../lib/signGCS.ts";
import { getContentType, resolveContentType } from "../lib/fileTypes.ts";
import BucketError from "../lib/BucketError.ts";
import { destKey } from "../lib/prefix.ts";
import {
  composeRange,
  isEmptyRange,
  rangeHeader,
  rangeSize,
  type ByteRange,
} from "../lib/range.ts";
import type {
  BucketFile,
  FileInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";

export interface GCSObjectMeta {
  name: string;
  contentType: string;
  size: string;
  updated: string;
  generation?: string;
  mediaLink: string;
  metadata?: Record<string, string>;
}

export type GCSAuth = { clientEmail: string; privateKey: string } | null;

export class GCSFile implements BucketFile {
  name: string;
  path: string;
  #bucket: string;
  #authPromise: Promise<GCSAuth>;
  #url: string;
  #anonymous: boolean;
  // Folder prefix of the bucket that created this file; copyTo()/moveTo()
  // destinations and rename() resolve against it.
  #prefix: string;
  #range: ByteRange | null = null;

  constructor(
    path: string,
    bucket: string,
    authPromise: Promise<GCSAuth>,
    url: string = "https://storage.googleapis.com",
    anonymous: boolean = false,
    prefix: string = "",
  ) {
    this.path = path.startsWith("/") ? path.slice(1) : path;
    this.name = this.path.split("/").pop() || this.path;
    this.#bucket = bucket;
    this.#authPromise = authPromise;
    this.#url = url;
    this.#anonymous = anonymous;
    this.#prefix = prefix;
  }

  slice(start: number, end?: number): GCSFile {
    const f = new GCSFile(
      this.path,
      this.#bucket,
      this.#authPromise,
      this.#url,
      this.#anonymous,
      this.#prefix,
    );
    f.#range = composeRange(this.#range, start, end);
    return f;
  }

  // A range-aware, status-checked media GET used by every reader. An empty
  // range resolves to an empty body without hitting the network.
  async #get(): Promise<Response> {
    if (this.#range && isEmptyRange(this.#range))
      return new Response(new Uint8Array(0));
    const rh = this.#range && rangeHeader(this.#range);
    const res = await fetch(this.#mediaUrl(), {
      headers: await this.#headers(rh ? { Range: rh } : {}),
    });
    if (!res.ok)
      throw new BucketError(`GCS GET error: ${res.status}`, {
        provider: "GCS",
        status: res.status,
      });
    return res;
  }

  #apiUrl(): string {
    return `${this.#url}/storage/v1/b/${this.#bucket}/o/${encodeURIComponent(this.path)}`;
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

  async info(): Promise<FileInfo | null> {
    const res = await fetch(this.#apiUrl(), { headers: await this.#headers() });
    if (res.status === 404) return null;
    if (!res.ok)
      throw new BucketError(`GCS info error: ${res.status}`, {
        provider: "GCS",
        status: res.status,
      });
    const meta = (await res.json()) as GCSObjectMeta;
    return {
      size: rangeSize(this.#range, parseInt(meta.size, 10)),
      type: meta.contentType,
      modified: new Date(meta.updated),
      version: meta.generation ?? null,
      metadata: meta.metadata ?? {},
    };
  }

  async exists(): Promise<boolean> {
    return (await this.info()) !== null;
  }

  async text(): Promise<string> {
    return (await this.#get()).text();
  }

  async json(): Promise<unknown> {
    return (await this.#get()).json();
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return (await this.#get()).arrayBuffer();
  }

  async blob(): Promise<Blob> {
    return (await this.#get()).blob();
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
      if (options.metadata)
        metaObj.metadata = Object.fromEntries(
          Object.entries(options.metadata).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        );

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

      const url = `${this.#url}/upload/storage/v1/b/${this.#bucket}/o?uploadType=multipart`;
      const res = await fetch(url, {
        method: "POST",
        headers: await this.#headers({
          "Content-Type": `multipart/related; boundary=${boundary}`,
        }),
        body,
      });
      if (!res.ok)
        throw new BucketError(`GCS PUT error: ${res.status}`, {
          provider: "GCS",
          status: res.status,
        });
    } else {
      const url = `${this.#url}/upload/storage/v1/b/${this.#bucket}/o?uploadType=media&name=${encodeURIComponent(this.path)}`;
      const extra: Record<string, string> = {};
      if (type) extra["Content-Type"] = type;
      const res = await fetch(url, {
        method: "POST",
        headers: await this.#headers(extra),
        body: data as BodyInit,
      });
      if (!res.ok)
        throw new BucketError(`GCS PUT error: ${res.status}`, {
          provider: "GCS",
          status: res.status,
        });
    }
  }

  // GCS resumable upload: open a session (the URI is a capability, no auth
  // needed on the chunks), then PUT sequential ranges. The final chunk
  // carries the total size in Content-Range, which completes the object, so
  // finish() is a no-op. Chunks must be 256 KiB multiples; 8 MiB is.
  #target(
    options: WriteOptions = {},
  ): ChunkedTarget<{ uri: string; offset: number }, number> {
    return {
      partSize: 8 * 1024 * 1024,
      single: (data) => this.#put(data, options),
      start: async () => {
        const type = options.type ?? getContentType(this.path);
        const metaObj: Record<string, unknown> = { name: this.path };
        if (type) metaObj.contentType = type;
        if (options.cacheControl) metaObj.cacheControl = options.cacheControl;
        if (options.disposition)
          metaObj.contentDisposition = options.disposition;
        if (options.metadata)
          metaObj.metadata = Object.fromEntries(
            Object.entries(options.metadata).map(([k, v]) => [
              k.toLowerCase(),
              v,
            ]),
          );
        const url = `${this.#url}/upload/storage/v1/b/${this.#bucket}/o?uploadType=resumable&name=${encodeURIComponent(this.path)}`;
        const res = await fetch(url, {
          method: "POST",
          headers: await this.#headers({ "Content-Type": "application/json" }),
          body: JSON.stringify(metaObj),
        });
        if (!res.ok)
          throw new BucketError(`GCS resumable start error: ${res.status}`, {
            provider: "GCS",
            status: res.status,
          });
        await res.text();
        const uri = res.headers.get("location");
        if (!uri)
          throw new BucketError("GCS resumable start: no session URI", {
            provider: "GCS",
          });
        return { uri, offset: 0 };
      },
      part: async (ctx, n, data, isLast) => {
        const from = ctx.offset;
        const to = ctx.offset + data.length - 1;
        const total = isLast ? String(ctx.offset + data.length) : "*";
        const res = await fetch(ctx.uri, {
          method: "PUT",
          headers: { "Content-Range": `bytes ${from}-${to}/${total}` },
          body: data as unknown as BodyInit,
        });
        // 308 means "resume incomplete": expected for every non-final chunk
        if (res.status !== 308 && !res.ok)
          throw new BucketError(`GCS resumable part error: ${res.status}`, {
            provider: "GCS",
            status: res.status,
          });
        await res.text();
        ctx.offset += data.length;
        return n;
      },
      finish: async () => {},
      abort: async (ctx) => {
        await fetch(ctx.uri, { method: "DELETE" }).catch(() => {});
      },
    };
  }

  async write(content: WriteContent, options?: WriteOptions): Promise<void> {
    if (typeof content === "string")
      return writeChunked(this.#target(options), Buffer.from(content));
    if (content instanceof Buffer || content instanceof Uint8Array)
      return writeChunked(this.#target(options), Buffer.from(content));
    if (content instanceof Blob) {
      const opts = {
        ...options,
        type: resolveContentType(this.path, content, options),
      };
      return writeChunked(
        this.#target(opts),
        Buffer.from(await content.arrayBuffer()),
      );
    }
    // A BucketFile from this or any other provider: stream it across
    if (
      typeof (content as BucketFile).stream === "function" &&
      typeof (content as BucketFile).info === "function"
    )
      return (content as BucketFile).stream().pipeTo(this.writable(options));
    if (typeof (content as ReadableStream).pipeTo === "function")
      return (content as ReadableStream).pipeTo(this.writable(options));
    if (content instanceof Readable)
      return Readable.toWeb(content).pipeTo(this.writable(options));
    throw new Error("Invalid content type");
  }

  async copyTo(dest: string | BucketFile): Promise<void> {
    if (typeof dest !== "string") {
      await dest.write(this);
      return;
    }
    const dst = destKey(this.#prefix, dest, this.name);
    const url = `${this.#url}/storage/v1/b/${this.#bucket}/o/${encodeURIComponent(this.path)}/copyTo/b/${this.#bucket}/o/${encodeURIComponent(dst)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: await this.#headers(),
    });
    if (!res.ok)
      throw new BucketError(`GCS COPY error: ${res.status}`, {
        provider: "GCS",
        status: res.status,
      });
  }

  async moveTo(dest: string | BucketFile): Promise<void> {
    await this.copyTo(dest);
    await this.remove();
  }

  async rename(name: string): Promise<void> {
    if (!name || name === "." || name === "..")
      throw new Error(`rename() needs a file name, got "${name}"`);
    if (name.includes("/"))
      throw new Error("rename() cannot change directory, use moveTo() instead");
    const prefix = this.#prefix;
    const rel = prefix ? this.path.slice(prefix.length + 1) : this.path;
    const dir = rel.split("/").slice(0, -1).join("/");
    await this.moveTo(dir ? dir + "/" + name : name);
  }

  async remove(): Promise<void> {
    const res = await fetch(this.#apiUrl(), {
      method: "DELETE",
      headers: await this.#headers(),
    });
    if (!res.ok && res.status !== 204)
      throw new BucketError(`GCS DELETE error: ${res.status}`, {
        provider: "GCS",
        status: res.status,
      });
  }

  // Bun-style aliases, so muscle memory from Bun's S3File carries over
  unlink(): Promise<void> {
    return this.remove();
  }

  stream(): ReadableStream {
    return promiseToReadable(async () => (await this.#get()).body!);
  }

  nodeReadable(): NodeJS.ReadableStream {
    return Readable.fromWeb(
      this.stream() as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
    );
  }

  writable(options?: WriteOptions): WritableStream {
    return chunkedWritable(this.#target(options));
  }

  nodeWritable(options?: WriteOptions): NodeJS.WritableStream {
    return Writable.fromWeb(
      this.writable(options) as unknown as WritableStream<Uint8Array>,
    );
  }

  async publicUrl(): Promise<string> {
    return `${this.#url}/${this.#bucket}/${this.path}`;
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
