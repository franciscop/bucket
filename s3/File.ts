import { Readable, Writable } from "node:stream";
import { presignS3 } from "../lib/presignS3.ts";
import parse from "../lib/parse.ts";
import promiseToReadable from "../lib/promiseToReadable.ts";
import promiseToWritable from "../lib/promiseToWritable.ts";
import { getContentType } from "../lib/fileTypes.ts";
import type {
  IBucketFile,
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
    options?: { body?: string | Buffer; headers?: Record<string, string> },
  ) => Promise<Response>;
  getAuth: () => Promise<S3Auth>;
  bucketName: string;
  endpoint: string;
}

export class S3File implements IBucketFile {
  id: string;
  name: string;
  path: string;
  #ctx: S3BucketContext;

  constructor(path: string, ctx: S3BucketContext) {
    this.path = path.startsWith("/") ? path.slice(1) : path;
    this.name = this.path.split("/").pop() || this.path;
    this.id = this.path;
    this.#ctx = ctx;
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
      };
    }
    if (!res.ok) throw new Error(`S3 HEAD error: ${res.status}`);
    return {
      id: this.id,
      name: this.name,
      path: this.path,
      exists: true,
      type: res.headers.get("content-type"),
      size: parseInt(res.headers.get("content-length") ?? "0", 10),
      date: new Date(res.headers.get("last-modified") ?? Date.now()),
      url: this.#ctx.makeUrl(this.path),
    };
  }

  async exists(): Promise<boolean> {
    return (await this.info()).exists;
  }

  async text(): Promise<string> {
    const res = await this.#ctx.doRequest("GET", this.path);
    if (!res.ok) throw new Error(`S3 GET error: ${res.status}`);
    return res.text();
  }

  async json(): Promise<unknown> {
    const res = await this.#ctx.doRequest("GET", this.path);
    if (!res.ok) throw new Error(`S3 GET error: ${res.status}`);
    return res.json();
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const res = await this.#ctx.doRequest("GET", this.path);
    if (!res.ok) throw new Error(`S3 GET error: ${res.status}`);
    return res.arrayBuffer();
  }

  async blob(): Promise<Blob> {
    const res = await this.#ctx.doRequest("GET", this.path);
    if (!res.ok) throw new Error(`S3 GET error: ${res.status}`);
    return res.blob();
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
        headers[`x-amz-meta-${k}`] = v;
      }
    }
    const res = await this.#ctx.doRequest("PUT", this.path, {
      body: data,
      headers,
    });
    if (!res.ok) throw new Error(`S3 PUT error: ${res.status}`);
  }

  async write(content: WriteContent, options?: WriteOptions): Promise<void> {
    if (typeof content === "string") return this.#put(content, options);
    if (content instanceof Buffer || content instanceof Uint8Array)
      return this.#put(Buffer.from(content), options);
    if (content instanceof Blob)
      return this.#put(Buffer.from(await content.arrayBuffer()), options);
    if (content instanceof S3File)
      return this.#put(Buffer.from(await content.arrayBuffer()), options);
    if (typeof (content as ReadableStream).pipeTo === "function")
      return (content as ReadableStream).pipeTo(this.writable(options));
    if (content instanceof Readable)
      return Readable.toWeb(content).pipeTo(this.writable(options));
    throw new Error("Invalid content type");
  }

  async copyTo(path: string): Promise<void> {
    const dst = path.startsWith("/") ? path.slice(1) : path;
    const res = await this.#ctx.doRequest("PUT", dst, {
      headers: { "x-amz-copy-source": `/${this.#ctx.bucketName}/${this.path}` },
    });
    if (!res.ok) throw new Error(`S3 COPY error: ${res.status}`);
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
    const res = await this.#ctx.doRequest("DELETE", this.path);
    if (!res.ok && res.status !== 204)
      throw new Error(`S3 DELETE error: ${res.status}`);
  }

  stream(): ReadableStream {
    return promiseToReadable(async () => {
      const res = await this.#ctx.doRequest("GET", this.path);
      if (!res.ok) throw new Error(`S3 GET error: ${res.status}`);
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
    return this.#ctx.makeUrl(this.path);
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
