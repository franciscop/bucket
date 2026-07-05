import { Readable, Writable } from "node:stream";
import { presignS3 } from "../lib/presignS3.ts";
import parse from "../lib/parse.ts";
import promiseToReadable from "../lib/promiseToReadable.ts";
import promiseToWritable from "../lib/promiseToWritable.ts";
import { getContentType, resolveContentType } from "../lib/fileTypes.ts";
import BucketError from "../lib/BucketError.ts";
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

export interface R2BucketContext {
  makeUrl: (path?: string) => string;
  doRequest: (
    method: string,
    path: string,
    options?: { body?: string | Buffer; headers?: Record<string, string> },
  ) => Promise<Response>;
  getAuth: () => S3Auth;
  bucketName: string;
  url: string;
}

export class R2File implements BucketFile {
  id: string;
  name: string;
  path: string;
  #ctx: R2BucketContext;
  #range: ByteRange | null = null;

  constructor(path: string, ctx: R2BucketContext) {
    this.path = path.startsWith("/") ? path.slice(1) : path;
    this.name = this.path.split("/").pop() || this.path;
    this.id = this.path;
    this.#ctx = ctx;
  }

  slice(start: number, end?: number): R2File {
    const f = new R2File(this.path, this.#ctx);
    f.#range = composeRange(this.#range, start, end);
    return f;
  }

  // A range-aware, status-checked GET used by every reader. An empty range
  // resolves to an empty body without hitting the network.
  async #get(): Promise<Response> {
    if (this.#range && isEmptyRange(this.#range))
      return new Response(new Uint8Array(0));
    const headers: Record<string, string> = {};
    const rh = this.#range && rangeHeader(this.#range);
    if (rh) headers.Range = rh;
    const res = await this.#ctx.doRequest("GET", this.path, { headers });
    if (!res.ok)
      throw new BucketError(`R2 GET error: ${res.status}`, {
        provider: "R2",
        status: res.status,
      });
    return res;
  }

  async info(): Promise<FileInfo> {
    const res = await this.#ctx.doRequest("HEAD", this.path);
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
        metadata: {},
      };
    }
    if (!res.ok)
      throw new BucketError(`R2 HEAD error: ${res.status}`, {
        provider: "R2",
        status: res.status,
      });
    return {
      id: this.id,
      name: this.name,
      path: this.path,
      exists: true,
      type: res.headers.get("content-type"),
      size: rangeSize(
        this.#range,
        parseInt(res.headers.get("content-length") ?? "0", 10),
      ),
      date: new Date(res.headers.get("last-modified") ?? Date.now()),
      url: this.publicUrl(),
      metadata: metaFromHeaders(res.headers, "x-amz-meta-"),
    };
  }

  async exists(): Promise<boolean> {
    return (await this.info()).exists;
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
    const headers: Record<string, string> = {};
    const type = options.type ?? getContentType(this.path);
    if (type) headers["Content-Type"] = type;
    if (options.cacheControl) headers["Cache-Control"] = options.cacheControl;
    if (options.disposition)
      headers["Content-Disposition"] = options.disposition;
    if (options.metadata) {
      for (const [k, v] of Object.entries(options.metadata)) {
        headers[`x-amz-meta-${k.toLowerCase()}`] = v;
      }
    }
    const res = await this.#ctx.doRequest("PUT", this.path, {
      body: data,
      headers,
    });
    if (!res.ok)
      throw new BucketError(`R2 PUT error: ${res.status}`, {
        provider: "R2",
        status: res.status,
      });
  }

  async write(content: WriteContent, options?: WriteOptions): Promise<void> {
    if (typeof content === "string") return this.#put(content, options);
    if (content instanceof Buffer || content instanceof Uint8Array)
      return this.#put(Buffer.from(content), options);
    if (content instanceof Blob)
      return this.#put(Buffer.from(await content.arrayBuffer()), {
        ...options,
        type: resolveContentType(this.path, content, options),
      });
    if (content instanceof R2File)
      return this.#put(Buffer.from(await content.arrayBuffer()), options);
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
    const dst = dest.startsWith("/") ? dest.slice(1) : dest;
    const res = await this.#ctx.doRequest("PUT", dst, {
      headers: { "x-amz-copy-source": `/${this.#ctx.bucketName}/${this.path}` },
    });
    if (!res.ok)
      throw new BucketError(`R2 COPY error: ${res.status}`, {
        provider: "R2",
        status: res.status,
      });
  }

  async moveTo(dest: string | BucketFile): Promise<void> {
    await this.copyTo(dest);
    await this.remove();
  }

  async rename(name: string): Promise<void> {
    if (name.includes("/"))
      throw new Error("rename() cannot change directory, use moveTo() instead");
    const dir = this.path.split("/").slice(0, -1).join("/");
    await this.moveTo(dir ? dir + "/" + name : name);
  }

  async remove(): Promise<void> {
    const res = await this.#ctx.doRequest("DELETE", this.path);
    if (!res.ok && res.status !== 204)
      throw new BucketError(`R2 DELETE error: ${res.status}`, {
        provider: "R2",
        status: res.status,
      });
  }

  // Bun-style aliases, so muscle memory from Bun's S3File carries over
  unlink(): Promise<void> {
    return this.remove();
  }

  presign(opts?: {
    method?: string;
    expiresIn?: number;
    expires?: number | string;
  }): Promise<string | null> {
    const expires = opts?.expires ?? opts?.expiresIn ?? 3600;
    const method = (opts?.method ?? "GET").toUpperCase();
    return method === "PUT" || method === "POST"
      ? this.uploadUrl({ expires })
      : this.signedUrl({ expires });
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
    return promiseToWritable((data: Buffer) => this.#put(data, options));
  }

  nodeWritable(options?: WriteOptions): NodeJS.WritableStream {
    return Writable.fromWeb(
      this.writable(options) as unknown as WritableStream<Uint8Array>,
    );
  }

  publicUrl(): string {
    return this.#ctx.makeUrl(this.path);
  }

  async signedUrl(opts: { expires: number | string }): Promise<string> {
    const seconds = parse(opts.expires) ?? 3600;
    return presignS3(
      this.#ctx.makeUrl(this.path),
      "GET",
      this.#ctx.getAuth(),
      seconds,
    );
  }

  async uploadUrl(opts: { expires: number | string }): Promise<string> {
    const seconds = parse(opts.expires) ?? 3600;
    return presignS3(
      this.#ctx.makeUrl(this.path),
      "PUT",
      this.#ctx.getAuth(),
      seconds,
    );
  }
}
