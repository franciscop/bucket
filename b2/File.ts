import { Readable, Writable } from "node:stream";
import parse from "../lib/parse.ts";
import { sha1hex } from "../lib/webcrypto.ts";
import promiseToReadable from "../lib/promiseToReadable.ts";
import chunkedWritable, {
  writeChunked,
  type ChunkedTarget,
} from "../lib/chunkedWritable.ts";
import { resolveContentType } from "../lib/fileTypes.ts";
import { destKey } from "../lib/prefix.ts";
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
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";

export interface B2UploadAuth {
  uploadUrl: string;
  authorizationToken: string;
}

export interface B2BucketContext {
  info(): Promise<BucketInfo>;
  fetch(url: string, options?: RequestInit): Promise<Response>;
  /** Part size for chunked uploads, resolved from the account's auth. */
  partSize(): Promise<number>;
  apiBase: string;
  // Folder prefix of the bucket that created this file; copyTo()/moveTo()
  // destinations and rename() resolve against it.
  PREFIX: string;
}

export class B2File implements BucketFile {
  name: string;
  path: string;
  #bucket: B2BucketContext;
  #range: ByteRange | null = null;

  constructor(path: string, bucket: B2BucketContext) {
    this.name = path.split("/").pop()!;
    this.path = path;
    this.#bucket = bucket;
  }

  slice(start: number, end?: number): B2File {
    const f = new B2File(this.path, this.#bucket);
    f.#range = composeRange(this.#range, start, end);
    return f;
  }

  // A range-aware download used by every reader. `bucket.fetch` throws on any
  // non-2xx (a range GET returns 206). An empty range resolves to an empty
  // body without hitting the network.
  async #get(): Promise<Response> {
    if (this.#range && isEmptyRange(this.#range))
      return new Response(new Uint8Array(0));
    const bucket = await this.#bucket.info();
    const url = bucket.url + "file/" + bucket.name + "/" + this.path;
    const rh = this.#range && rangeHeader(this.#range);
    return this.#bucket.fetch(url, rh ? { headers: { Range: rh } } : {});
  }

  async info(): Promise<FileInfo | null> {
    // B2 has no metadata-by-name endpoint, but a HEAD on the download-by-name
    // URL returns it in headers. `bucket.fetch` throws on any non-2xx, so a
    // missing file (404) surfaces as a throw; per the documented contract
    // info()/exists() never throw, so any failure means "does not exist".
    const bucket = await this.#bucket.info();
    const url = bucket.url + "file/" + bucket.name + "/" + this.path;
    let res: Response;
    try {
      res = await this.#bucket.fetch(url, { method: "HEAD" });
    } catch {
      return null;
    }
    const ts = res.headers.get("x-bz-upload-timestamp");
    return {
      size: rangeSize(
        this.#range,
        Number(res.headers.get("content-length") ?? 0),
      ),
      type: res.headers.get("content-type"),
      modified: ts ? new Date(Number(ts)) : new Date(),
      version: res.headers.get("x-bz-file-id"),
      metadata: metaFromHeaders(res.headers, "x-bz-info-", (k) =>
        k.startsWith("b2-"),
      ),
    };
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

  async exists(): Promise<boolean> {
    return (await this.info()) !== null;
  }

  async #put(data: string | Buffer, options: WriteOptions = {}): Promise<void> {
    const bucket = await this.#bucket.info();
    const url =
      this.#bucket.apiBase + "b2_get_upload_url?bucketId=" + bucket.id;
    const res = await this.#bucket.fetch(url);
    const auth = (await res.json()) as B2UploadAuth;

    // Detect from the extension like every other provider; fall back to B2's
    // server-side auto-detection ("b2/x-auto") only for unknown extensions.
    const type =
      resolveContentType(this.path, undefined, options) ?? "b2/x-auto";
    const headers: Record<string, string | number> = {
      Authorization: auth.authorizationToken,
      "X-Bz-File-Name": this.path,
      "X-Bz-Content-Sha1": await sha1hex(data),
      "Content-Length": Buffer.byteLength(data as string),
      "Content-Type": type,
    };
    if (options.cacheControl)
      headers["X-Bz-Info-b2-cache-control"] = options.cacheControl;
    if (options.disposition)
      headers["X-Bz-Info-b2-content-disposition"] = options.disposition;
    if (options.metadata) {
      for (const [k, v] of Object.entries(options.metadata)) {
        headers[`X-Bz-Info-${k.toLowerCase()}`] = v;
      }
    }
    const res2 = await this.#bucket.fetch(auth.uploadUrl, {
      body: data as BodyInit,
      method: "POST",
      headers: headers as Record<string, string>,
    });
    await res2.json();
  }

  // B2 large-file upload: b2_start_large_file → b2_upload_part × n →
  // b2_finish_large_file, cancelling on failure so no orphan parts remain.
  #target(
    options: WriteOptions = {},
  ): ChunkedTarget<{ fileId: string }, string> {
    return {
      partSize: () => this.#bucket.partSize(),
      single: (data) => this.#put(data, options),
      start: async () => {
        const bucket = await this.#bucket.info();
        const type =
          resolveContentType(this.path, undefined, options) ?? "b2/x-auto";
        const fileInfo: Record<string, string> = {};
        if (options.cacheControl)
          fileInfo["b2-cache-control"] = options.cacheControl;
        if (options.disposition)
          fileInfo["b2-content-disposition"] = options.disposition;
        if (options.metadata) {
          for (const [k, v] of Object.entries(options.metadata)) {
            fileInfo[k.toLowerCase()] = v;
          }
        }
        const res = await this.#bucket.fetch(
          this.#bucket.apiBase + "b2_start_large_file",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bucketId: bucket.id,
              fileName: this.path,
              contentType: type,
              fileInfo,
            }),
          },
        );
        const { fileId } = (await res.json()) as { fileId: string };
        return { fileId };
      },
      part: async (ctx, n, data) => {
        const urlRes = await this.#bucket.fetch(
          this.#bucket.apiBase + "b2_get_upload_part_url?fileId=" + ctx.fileId,
        );
        const auth = (await urlRes.json()) as B2UploadAuth;
        const sha1 = await sha1hex(data);
        const res = await this.#bucket.fetch(auth.uploadUrl, {
          method: "POST",
          body: data as unknown as BodyInit,
          headers: {
            Authorization: auth.authorizationToken,
            "X-Bz-Part-Number": String(n),
            "Content-Length": String(data.length),
            "X-Bz-Content-Sha1": sha1,
          },
        });
        await res.json();
        return sha1;
      },
      finish: async (ctx, parts) => {
        const res = await this.#bucket.fetch(
          this.#bucket.apiBase + "b2_finish_large_file",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileId: ctx.fileId, partSha1Array: parts }),
          },
        );
        await res.json();
      },
      abort: async (ctx) => {
        const res = await this.#bucket.fetch(
          this.#bucket.apiBase + "b2_cancel_large_file",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileId: ctx.fileId }),
          },
        );
        await res.json();
      },
    };
  }

  async write(content: WriteContent, options?: WriteOptions): Promise<B2File> {
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

  async copyTo(dest: string | BucketFile): Promise<BucketFile> {
    if (typeof dest !== "string") return dest.write(this);
    const dst = new B2File(
      destKey(this.#bucket.PREFIX, dest, this.name),
      this.#bucket,
    );
    return dst.write(this);
  }

  async moveTo(dest: string | BucketFile): Promise<BucketFile> {
    const moved = await this.copyTo(dest);
    // Hides the source like any remove(), keeping its versions: a move must
    // never destroy history that removing the same file would have kept.
    await this.remove();
    return moved;
  }

  async rename(name: string): Promise<BucketFile> {
    if (!name || name === "." || name === "..")
      throw new Error(`rename() needs a file name, got "${name}"`);
    if (name.includes("/"))
      throw new Error("rename() cannot change directory, use moveTo() instead");
    const prefix = this.#bucket.PREFIX;
    const rel = prefix ? this.path.slice(prefix.length + 1) : this.path;
    const dir = rel.split("/").slice(0, -1).join("/");
    return this.moveTo(dir ? dir + "/" + name : name);
  }

  async remove(): Promise<B2File> {
    const bucket = await this.#bucket.info();
    // Hide, never delete: B2 is always versioned, and deleting the newest
    // version would both destroy it and uncover the one before it. Hiding
    // stops the path resolving and keeps the history for lifecycle rules.
    await this.#bucket
      .fetch(this.#bucket.apiBase + "b2_hide_file", {
        method: "POST",
        body: JSON.stringify({ bucketId: bucket.id, fileName: this.path }),
        headers: { "Content-Type": "application/json" },
      })
      .catch((e: Error) => {
        // Already hidden, or never there: a no-op, and no second hide marker
        if (!/file_not_present|no_such_file/.test(e.message)) throw e;
      });
    return this;
  }

  // Bun-style aliases, so muscle memory from Bun's S3File carries over
  unlink(): Promise<B2File> {
    return this.remove();
  }

  stream(): ReadableStream {
    return promiseToReadable(
      async () => (await this.#get()).body as unknown as ReadableStream,
    );
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
      this.writable(options) as WritableStream<Uint8Array>,
    );
  }

  async publicUrl(): Promise<string> {
    // The download base is only known once the bucket has authenticated;
    // info() resolves that auth, so the URL is always available here.
    const bucket = await this.#bucket.info();
    return `${bucket.url}file/${bucket.name}/${this.path}`;
  }

  async signedUrl(opts: { expires: number | string }): Promise<string> {
    const seconds = Math.ceil(parse(opts.expires) ?? 3600);
    const bucket = await this.#bucket.info();
    const url = this.#bucket.apiBase + "b2_get_download_authorization";
    const res = await this.#bucket.fetch(url, {
      method: "POST",
      body: JSON.stringify({
        bucketId: bucket.id,
        fileNamePrefix: this.path,
        validDurationInSeconds: seconds,
      }),
      headers: { "Content-Type": "application/json" },
    });
    const { authorizationToken } = (await res.json()) as {
      authorizationToken: string;
    };
    return (
      bucket.url +
      "file/" +
      bucket.name +
      "/" +
      this.path +
      "?Authorization=" +
      encodeURIComponent(authorizationToken)
    );
  }

  async uploadUrl(_opts: { expires: number | string }): Promise<null> {
    return null;
  }
}
