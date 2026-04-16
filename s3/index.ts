import "dotenv/config";

import { Readable, Writable } from "node:stream";
import cleanAndSignS3 from "../lib/cleanAndSignS3.ts";
import { presignS3 } from "../lib/presignS3.ts";
import parse from "../lib/parse.ts";
import promiseToReadable from "../lib/promiseToReadable.ts";
import promiseToWritable from "../lib/promiseToWritable.ts";
import { getContentType } from "../lib/fileTypes.ts";
import type {
  IBucket,
  IBucketFile,
  FileInfo,
  BucketInfo,
  WriteContent,
  WriteOptions,
  S3Auth,
  S3Request,
} from "../lib/types.ts";

const {
  AWS_BUCKET: ENV_BUCKET,
  AWS_ACCESS_KEY_ID: ENV_ID,
  AWS_SECRET_ACCESS_KEY: ENV_KEY,
  AWS_REGION: ENV_REGION,
  AWS_ENDPOINT: ENV_ENDPOINT,
} = process.env;

interface S3Config {
  id?: string;
  secret?: string;
  region?: string;
  endpoint?: string;
}

interface S3FileEntry {
  id: string;
  name: string;
  path: string;
  type: string | null;
  size: number;
  date: Date;
  url: string;
}

interface S3BucketContext {
  makeUrl: (path?: string) => string;
  doRequest: (
    method: string,
    path: string,
    options?: { body?: string | Buffer; headers?: Record<string, string> },
  ) => Promise<Response>;
  auth: S3Auth;
  bucketName: string;
  endpoint: string;
}

// Simple inline XML extractor for S3 list responses
function extractTags(xmlStr: string, tag: string): string[] {
  const results: string[] = [];
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xmlStr)) !== null) {
    results.push(match[1]);
  }
  return results;
}

function getTag(xmlStr: string, tag: string): string {
  return extractTags(xmlStr, tag)[0] ?? "";
}

class S3File implements IBucketFile {
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
    if (!res.ok) {
      throw new Error(`S3 HEAD error: ${res.status}`);
    }
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
    if (options.disposition) headers["Content-Disposition"] = options.disposition;
    if (options.metadata) {
      for (const [k, v] of Object.entries(options.metadata)) {
        headers[`x-amz-meta-${k}`] = v;
      }
    }
    const res = await this.#ctx.doRequest("PUT", this.path, { body: data, headers });
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
      headers: {
        "x-amz-copy-source": `/${this.#ctx.bucketName}/${this.path}`,
      },
    });
    if (!res.ok) throw new Error(`S3 COPY error: ${res.status}`);
  }

  async moveTo(path: string): Promise<void> {
    await this.copyTo(path);
    await this.remove();
  }

  async rename(name: string): Promise<void> {
    if (name.includes("/"))
      throw new Error("rename() cannot change directory — use moveTo() instead");
    const dir = this.path.split("/").slice(0, -1).join("/");
    await this.moveTo(dir ? dir + "/" + name : name);
  }

  async remove(): Promise<void> {
    const res = await this.#ctx.doRequest("DELETE", this.path);
    if (!res.ok && res.status !== 204) {
      throw new Error(`S3 DELETE error: ${res.status}`);
    }
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
    return presignS3(this.#ctx.makeUrl(this.path), "GET", this.#ctx.auth, seconds);
  }

  async uploadUrl(opts: { expires: number | string }): Promise<string> {
    const seconds = parse(opts.expires) ?? 3600;
    return presignS3(this.#ctx.makeUrl(this.path), "PUT", this.#ctx.auth, seconds);
  }
}

class S3Bucket implements IBucket {
  readonly type = "S3";
  private bucketName: string;
  private auth: S3Auth;
  private endpoint: string;

  constructor(
    bucketName: string = ENV_BUCKET || "",
    {
      id = ENV_ID || "",
      secret = ENV_KEY || "",
      region = ENV_REGION || "us-east-1",
      endpoint,
    }: S3Config = {},
  ) {
    this.bucketName = bucketName;
    this.auth = { id, secret, region };
    this.endpoint =
      endpoint ||
      ENV_ENDPOINT ||
      `https://${bucketName}.s3.${region}.amazonaws.com`;
  }

  private makeUrl(path: string = ""): string {
    const cleanPath = path ? (path.startsWith("/") ? path : "/" + path) : "";
    return this.endpoint + cleanPath;
  }

  private async doRequest(
    method: string,
    path: string,
    options: { body?: string | Buffer; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const url = this.makeUrl(path);
    const req: S3Request = {
      url,
      method: method.toLowerCase(),
      headers: { ...(options.headers || {}) },
      body: options.body,
    };
    cleanAndSignS3(req, this.auth);

    return fetch(url, {
      method: method.toUpperCase(),
      headers: req.headers,
      body: options.body as BodyInit | undefined,
    });
  }

  async info(): Promise<BucketInfo> {
    return {
      id: this.auth.id,
      name: this.bucketName,
      type: this.type,
      endpoint: this.endpoint,
    };
  }

  async list(filter?: string | RegExp): Promise<S3File[]> {
    const files: S3File[] = [];
    let token: string | undefined;

    do {
      const url = new URL(this.makeUrl(""));
      url.searchParams.set("list-type", "2");
      if (filter && typeof filter === "string")
        url.searchParams.set("prefix", filter);
      if (token) url.searchParams.set("continuation-token", token);

      const req: S3Request = {
        url: url.toString(),
        method: "get",
        headers: {},
      };
      cleanAndSignS3(req, this.auth);

      const res = await fetch(url.toString(), {
        method: "GET",
        headers: req.headers,
      });

      if (!res.ok) throw new Error(`S3 list error: ${res.status}`);

      const xmlStr = await res.text();
      for (const item of extractTags(xmlStr, "Contents")) {
        const key = getTag(item, "Key");
        if (filter instanceof RegExp && !filter.test(key)) continue;
        files.push(this.file(key));
      }

      token =
        getTag(xmlStr, "IsTruncated") === "true"
          ? getTag(xmlStr, "NextContinuationToken")
          : undefined;
    } while (token);

    return files;
  }

  async remove(filter?: string | RegExp): Promise<S3File[]> {
    const files = await this.list(filter);
    if (!files.length) return [];

    // S3 DeleteObjects: up to 1000 keys per request
    const deleted: S3File[] = [];
    for (let i = 0; i < files.length; i += 1000) {
      const batch = files.slice(i, i + 1000);
      const body =
        `<Delete>` +
        batch.map((f) => `<Object><Key>${f.path}</Key></Object>`).join("") +
        `</Delete>`;

      const url = new URL(this.makeUrl(""));
      url.searchParams.set("delete", "");
      const req: S3Request = {
        url: url.toString(),
        method: "post",
        headers: { "content-md5": "" },
        body,
      };
      cleanAndSignS3(req, this.auth);

      const res = await fetch(url.toString(), {
        method: "POST",
        headers: req.headers,
        body,
      });
      if (!res.ok) throw new Error(`S3 delete error: ${res.status}`);

      const xmlStr = await res.text();
      const keys = extractTags(xmlStr, "Deleted").map((d) =>
        getTag(d, "Key"),
      );
      deleted.push(...batch.filter((f) => keys.includes(f.path)));
    }

    return deleted;
  }

  file(name: string): S3File {
    if (!name) throw new Error("No name");
    const ctx: S3BucketContext = {
      makeUrl: (p) => this.makeUrl(p),
      doRequest: (m, p, opts) => this.doRequest(m, p, opts),
      auth: this.auth,
      bucketName: this.bucketName,
      endpoint: this.endpoint,
    };
    return new S3File(name, ctx);
  }

  async count(filter?: string | RegExp): Promise<number> {
    return (await this.list(filter)).length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<S3File> {
    for (const file of await this.list()) {
      yield file;
    }
  }
}

/**
 * Create an AWS S3 bucket handle.
 *
 * @param bucket - Bucket name (falls back to `AWS_S3_BUCKET` env var)
 * @param config.id - Access Key ID (falls back to `AWS_ACCESS_KEY_ID`)
 * @param config.secret - Secret Access Key (falls back to `AWS_SECRET_ACCESS_KEY`)
 * @param config.region - AWS region, default `"us-east-1"` (falls back to `AWS_REGION`)
 * @param config.endpoint - Custom endpoint URL (falls back to `AWS_ENDPOINT`)
 *
 * @example
 * const bucket = S3("my-bucket", { id: "keyId", secret: "secretKey", region: "us-west-2" });
 * await bucket.file("hello.txt").write("hello");
 */
export default function S3(bucket?: string, config?: S3Config): S3Bucket {
  return new S3Bucket(bucket, config);
}

export { S3Bucket, S3File };
