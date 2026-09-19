import { Readable, Writable } from "node:stream";
import { presignS3 } from "../lib/presignS3.ts";
import parse from "../lib/parse.ts";
import promiseToReadable from "../lib/promiseToReadable.ts";
import chunkedWritable, { writeChunked } from "../lib/chunkedWritable.ts";
import multipartS3 from "../lib/multipartS3.ts";
import { resolveContentType } from "../lib/fileTypes.ts";
import BucketError from "../lib/BucketError.ts";
import { destKey } from "../lib/prefix.ts";
import { publicUrlFrom } from "../lib/publicUrl.ts";
import { throwIfAborted, type ReadOptions } from "../lib/abort.ts";
import metaFromHeaders from "../lib/meta.ts";
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
  S3Auth,
} from "../lib/types.ts";

export interface S3BucketContext {
  makeUrl: (path?: string) => string;
  doRequest: (
    method: string,
    path: string,
    options?: {
      body?: string | Buffer;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    },
  ) => Promise<Response>;
  getAuth: () => Promise<S3Auth>;
  bucketName: string;
  url: string;
  publicUrl: string;
  // Folder prefix of the bucket that created this file; copyTo()/moveTo()
  // destinations and rename() resolve against it.
  prefix: string;
}

export class S3File implements BucketFile {
  name: string;
  path: string;
  #ctx: S3BucketContext;
  #range: ByteRange | null = null;

  constructor(path: string, ctx: S3BucketContext) {
    this.path = path.startsWith("/") ? path.slice(1) : path;
    this.name = this.path.split("/").pop() || this.path;
    this.#ctx = ctx;
  }

  slice(start: number, end?: number): S3File {
    const f = new S3File(this.path, this.#ctx);
    f.#range = composeRange(this.#range, start, end);
    return f;
  }

  // A range-aware, status-checked GET used by every reader. An empty range
  // resolves to an empty body without hitting the network.
  async #get(opts?: ReadOptions): Promise<Response> {
    throwIfAborted(opts?.signal);
    if (this.#range && isEmptyRange(this.#range))
      return new Response(new Uint8Array(0));
    const headers: Record<string, string> = {};
    const rh = this.#range && rangeHeader(this.#range);
    if (rh) headers.Range = rh;
    const res = await this.#ctx.doRequest("GET", this.path, {
      headers,
      signal: opts?.signal,
    });
    if (!res.ok)
      throw new BucketError(`S3 GET error: ${res.status}`, {
        provider: "S3",
        status: res.status,
      });
    return res;
  }

  async info(opts?: ReadOptions): Promise<FileInfo | null> {
    throwIfAborted(opts?.signal);
    const res = await this.#ctx.doRequest("HEAD", this.path, {
      signal: opts?.signal,
    });
    if (res.status === 404) return null;
    if (!res.ok)
      throw new BucketError(`S3 HEAD error: ${res.status}`, {
        provider: "S3",
        status: res.status,
      });
    return {
      size: rangeSize(
        this.#range,
        parseInt(res.headers.get("content-length") ?? "0", 10),
      ),
      type: res.headers.get("content-type"),
      modified: new Date(res.headers.get("last-modified") ?? Date.now()),
      version: res.headers.get("x-amz-version-id"),
      metadata: metaFromHeaders(res.headers, "x-amz-meta-"),
    };
  }

  async exists(opts?: ReadOptions): Promise<boolean> {
    return (await this.info(opts)) !== null;
  }

  async text(opts?: ReadOptions): Promise<string> {
    return (await this.#get(opts)).text();
  }

  async json(opts?: ReadOptions): Promise<unknown> {
    return (await this.#get(opts)).json();
  }

  async arrayBuffer(opts?: ReadOptions): Promise<ArrayBuffer> {
    return (await this.#get(opts)).arrayBuffer();
  }

  async blob(opts?: ReadOptions): Promise<Blob> {
    return (await this.#get(opts)).blob();
  }

  async bytes(opts?: ReadOptions): Promise<Uint8Array> {
    return new Uint8Array(await this.arrayBuffer(opts));
  }

  #putHeaders(options: WriteOptions = {}): Record<string, string> {
    const headers: Record<string, string> = {};
    const type = resolveContentType(this.path, undefined, options);
    if (type) headers["Content-Type"] = type;
    if (options.cacheControl) headers["Cache-Control"] = options.cacheControl;
    if (options.disposition)
      headers["Content-Disposition"] = options.disposition;
    if (options.metadata) {
      for (const [k, v] of Object.entries(options.metadata)) {
        headers[`x-amz-meta-${k.toLowerCase()}`] = v;
      }
    }
    return headers;
  }

  async #put(data: string | Buffer, options: WriteOptions = {}): Promise<void> {
    const res = await this.#ctx.doRequest("PUT", this.path, {
      body: data,
      headers: this.#putHeaders(options),
      signal: options.signal,
    });
    if (!res.ok)
      throw new BucketError(`S3 PUT error: ${res.status}`, {
        provider: "S3",
        status: res.status,
      });
  }

  #target(options?: WriteOptions) {
    return multipartS3({
      provider: "S3",
      path: this.path,
      makeUrl: this.#ctx.makeUrl,
      getAuth: this.#ctx.getAuth,
      headers: this.#putHeaders(options),
      single: (data) => this.#put(data, options),
      signal: options?.signal,
    });
  }

  async write(content: WriteContent, options?: WriteOptions): Promise<S3File> {
    throwIfAborted(options?.signal);
    await this.#write(content, options);
    return this;
  }

  async #write(content: WriteContent, options?: WriteOptions): Promise<void> {
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

  async copyTo(
    dest: string | BucketFile,
    opts?: ReadOptions,
  ): Promise<BucketFile> {
    throwIfAborted(opts?.signal);
    if (typeof dest !== "string") return dest.write(this, opts);
    const dst = destKey(this.#ctx.prefix, dest, this.name);
    const res = await this.#ctx.doRequest("PUT", dst, {
      headers: { "x-amz-copy-source": `/${this.#ctx.bucketName}/${this.path}` },
      signal: opts?.signal,
    });
    if (!res.ok)
      throw new BucketError(`S3 COPY error: ${res.status}`, {
        provider: "S3",
        status: res.status,
      });
    return new S3File(dst, this.#ctx);
  }

  async moveTo(
    dest: string | BucketFile,
    opts?: ReadOptions,
  ): Promise<BucketFile> {
    const moved = await this.copyTo(dest, opts);
    await this.remove(opts);
    return moved;
  }

  async rename(name: string, opts?: ReadOptions): Promise<BucketFile> {
    if (!name || name === "." || name === "..")
      throw new Error(`rename() needs a file name, got "${name}"`);
    if (name.includes("/"))
      throw new Error("rename() cannot change directory, use moveTo() instead");
    const prefix = this.#ctx.prefix;
    const rel = prefix ? this.path.slice(prefix.length + 1) : this.path;
    const dir = rel.split("/").slice(0, -1).join("/");
    return this.moveTo(dir ? dir + "/" + name : name, opts);
  }

  async remove(opts?: ReadOptions): Promise<S3File> {
    throwIfAborted(opts?.signal);
    const res = await this.#ctx.doRequest("DELETE", this.path, {
      signal: opts?.signal,
    });
    // Already gone is success: removing a path twice is a no-op
    if (res.status === 404) return this;
    if (!res.ok && res.status !== 204)
      throw new BucketError(`S3 DELETE error: ${res.status}`, {
        provider: "S3",
        status: res.status,
      });
    return this;
  }

  // Bun-style aliases, so muscle memory from Bun's S3File carries over
  unlink(opts?: ReadOptions): Promise<S3File> {
    return this.remove(opts);
  }

  stream(opts?: ReadOptions): ReadableStream {
    return promiseToReadable(async () => (await this.#get(opts)).body!);
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
    const base = this.#ctx.publicUrl;
    return base
      ? publicUrlFrom(base, this.path)
      : publicUrlFrom(this.#ctx.url, this.path);
  }

  async signedUrl(opts: { expires: number | string }): Promise<string> {
    const seconds = parse(opts.expires) ?? 3600;
    const auth = await this.#ctx.getAuth();
    return presignS3(this.#ctx.makeUrl(this.path), "GET", auth, seconds);
  }

  async uploadUrl(opts: { expires: number | string }): Promise<string> {
    const seconds = parse(opts.expires) ?? 3600;
    const auth = await this.#ctx.getAuth();
    return presignS3(this.#ctx.makeUrl(this.path), "PUT", auth, seconds);
  }
}
