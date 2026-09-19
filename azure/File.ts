import { Readable, Writable } from "node:stream";
import {
  signAzure,
  presignAzure,
  accountPathPrefix,
} from "../lib/signAzure.ts";
import parse from "../lib/parse.ts";
import promiseToReadable from "../lib/promiseToReadable.ts";
import chunkedWritable, {
  writeChunked,
  type ChunkedTarget,
} from "../lib/chunkedWritable.ts";
import { resolveContentType } from "../lib/fileTypes.ts";
import BucketError from "../lib/BucketError.ts";
import { publicUrlFrom } from "../lib/publicUrl.ts";
import {
  throwIfAborted,
  withAbortFetch,
  type ReadOptions,
} from "../lib/abort.ts";
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
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";

// Azure signs the canonicalized resource with the path as sent, and the WHATWG
// URL parser percent-encodes "<" and ">" in URL paths, so encode them up
// front and sign that same form (mirrors lib/encodeS3Path for S3/R2).
const encodePath = (path: string): string =>
  path.replace(
    /[<>]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );

export type AzureFileAuth =
  | { type: "shared-key"; key: string }
  | { type: "managed-identity"; getToken: () => Promise<string> };

export class AzureFile implements BucketFile {
  name: string;
  path: string;
  #account: string;
  #container: string;
  #url: string;
  #auth: AzureFileAuth;
  #publicUrl: string;
  // Folder prefix of the bucket that created this file; copyTo()/moveTo()
  // destinations and rename() resolve against it.
  #prefix: string;
  #range: ByteRange | null = null;

  constructor(
    path: string,
    account: string,
    container: string,
    auth: AzureFileAuth,
    url: string = `https://${account}.blob.core.windows.net`,
    prefix: string = "",
    publicUrl: string = "",
  ) {
    this.path = path.startsWith("/") ? path.slice(1) : path;
    this.name = this.path.split("/").pop() || this.path;
    this.#account = account;
    this.#container = container;
    this.#url = url;
    this.#auth = auth;
    this.#prefix = prefix;
    this.#publicUrl = publicUrl;
  }

  slice(start: number, end?: number): AzureFile {
    const f = new AzureFile(
      this.path,
      this.#account,
      this.#container,
      this.#auth,
      this.#url,
      this.#prefix,
    );
    f.#range = composeRange(this.#range, start, end);
    return f;
  }

  // A range-aware, status-checked GET used by every reader. Azure's SharedKey
  // StringToSign has no slot for a standard `Range` header, but it does sign
  // every `x-ms-*` header, so we use `x-ms-range`. An empty range resolves to
  // an empty body without hitting the network.
  async #get(opts?: ReadOptions): Promise<Response> {
    throwIfAborted(opts?.signal);
    if (this.#range && isEmptyRange(this.#range))
      return new Response(new Uint8Array(0));
    const rh = this.#range && rangeHeader(this.#range);
    const res = await this.#request(
      "GET",
      rh ? { "x-ms-range": rh } : {},
      undefined,
      opts?.signal,
    );
    if (!res.ok)
      throw new BucketError(`Azure GET error: ${res.status}`, {
        provider: "Azure",
        status: res.status,
      });
    return res;
  }

  #baseUrl(): string {
    return `${this.#url}/${this.#container}/${encodePath(this.path)}`;
  }

  async #request(
    method: string,
    extraHeaders: Record<string, string> = {},
    body?: string | Buffer,
    signal?: AbortSignal,
  ): Promise<Response> {
    const blobPath = `${accountPathPrefix(this.#url)}/${this.#container}/${encodePath(this.path)}`;
    const allExtra = {
      ...extraHeaders,
      ...(body !== undefined
        ? { "Content-Length": String(Buffer.byteLength(body)) }
        : {}),
    };

    if (this.#auth.type === "shared-key") {
      const headers = await signAzure(method, blobPath, allExtra, {
        account: this.#account,
        key: this.#auth.key,
      });
      return withAbortFetch(signal, this.#baseUrl(), {
        method,
        headers,
        body: body as BodyInit | undefined,
      });
    }

    const token = await this.#auth.getToken();
    return withAbortFetch(signal, this.#baseUrl(), {
      method,
      headers: {
        ...allExtra,
        "x-ms-date": new Date().toUTCString(),
        "x-ms-version": "2020-10-02",
        Authorization: `Bearer ${token}`,
      },
      body: body as BodyInit | undefined,
    });
  }

  async info(opts?: ReadOptions): Promise<FileInfo | null> {
    throwIfAborted(opts?.signal);
    const res = await this.#request("HEAD", {}, undefined, opts?.signal);
    if (res.status === 404) return null;
    if (!res.ok)
      throw new BucketError(`Azure HEAD error: ${res.status}`, {
        provider: "Azure",
        status: res.status,
      });
    return {
      size: rangeSize(
        this.#range,
        parseInt(res.headers.get("content-length") ?? "0", 10),
      ),
      type: res.headers.get("content-type"),
      modified: new Date(res.headers.get("last-modified") ?? Date.now()),
      version: res.headers.get("x-ms-version-id"),
      metadata: metaFromHeaders(res.headers, "x-ms-meta-"),
    };
  }

  async exists(opts?: ReadOptions): Promise<boolean> {
    throwIfAborted(opts?.signal);
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

  #blobHeaders(options: WriteOptions = {}): Record<string, string> {
    const headers: Record<string, string> = {};
    const type = resolveContentType(this.path, undefined, options);
    if (type) headers["x-ms-blob-content-type"] = type;
    if (options.cacheControl)
      headers["x-ms-blob-cache-control"] = options.cacheControl;
    if (options.disposition)
      headers["x-ms-blob-content-disposition"] = options.disposition;
    if (options.metadata) {
      for (const [k, v] of Object.entries(options.metadata)) {
        headers[`x-ms-meta-${k.toLowerCase()}`] = v;
      }
    }
    return headers;
  }

  async #put(data: string | Buffer, options: WriteOptions = {}): Promise<void> {
    const extraHeaders: Record<string, string> = {
      "x-ms-blob-type": "BlockBlob",
      ...this.#blobHeaders(options),
    };
    const res = await this.#request("PUT", extraHeaders, data, options.signal);
    if (!res.ok)
      throw new BucketError(`Azure PUT error: ${res.status}`, {
        provider: "Azure",
        status: res.status,
      });
  }

  // Like #request but with query params, which Azure's SharedKey signature
  // includes in the canonical resource (needed for ?comp=block / blocklist).
  async #requestQuery(
    method: string,
    params: Record<string, string>,
    extraHeaders: Record<string, string> = {},
    body?: Buffer | string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const blobPath = `${accountPathPrefix(this.#url)}/${this.#container}/${encodePath(this.path)}`;
    const query = new URLSearchParams(params).toString();
    const url = `${this.#baseUrl()}?${query}`;
    const allExtra = {
      ...extraHeaders,
      ...(body !== undefined
        ? { "Content-Length": String(Buffer.byteLength(body as string)) }
        : {}),
    };

    if (this.#auth.type === "shared-key") {
      const headers = await signAzure(
        method,
        blobPath,
        allExtra,
        { account: this.#account, key: this.#auth.key },
        params,
      );
      return withAbortFetch(signal, url, {
        method,
        headers,
        body: body as BodyInit | undefined,
      });
    }

    const token = await this.#auth.getToken();
    return withAbortFetch(signal, url, {
      method,
      headers: {
        ...allExtra,
        "x-ms-date": new Date().toUTCString(),
        "x-ms-version": "2020-10-02",
        Authorization: `Bearer ${token}`,
      },
      body: body as BodyInit | undefined,
    });
  }

  // Azure block upload: Put Block × n, then Put Block List to commit. There
  // is no server-side session to open or abort; uncommitted blocks are
  // garbage-collected by Azure after about a week.
  #target(options: WriteOptions = {}): ChunkedTarget<string[], string> {
    // Block ids must be base64 and all the same length, so pad the index.
    const blockId = (n: number): string =>
      Buffer.from(String(n).padStart(6, "0")).toString("base64");
    return {
      partSize: 8 * 1024 * 1024,
      single: (data) => this.#put(data, options),
      start: async () => [],
      part: async (ids, n, data) => {
        const id = blockId(n);
        const res = await this.#requestQuery(
          "PUT",
          { comp: "block", blockid: id },
          {},
          data,
          options.signal,
        );
        if (!res.ok)
          throw new BucketError(`Azure block error: ${res.status}`, {
            provider: "Azure",
            status: res.status,
          });
        await res.text();
        ids.push(id);
        return id;
      },
      finish: async (ids) => {
        const body =
          `<?xml version="1.0" encoding="utf-8"?><BlockList>` +
          ids.map((id) => `<Latest>${id}</Latest>`).join("") +
          `</BlockList>`;
        const res = await this.#requestQuery(
          "PUT",
          { comp: "blocklist" },
          this.#blobHeaders(options),
          body,
          options.signal,
        );
        if (!res.ok)
          throw new BucketError(`Azure block commit error: ${res.status}`, {
            provider: "Azure",
            status: res.status,
          });
        await res.text();
      },
      abort: async () => {},
    };
  }

  async write(
    content: WriteContent,
    options?: WriteOptions,
  ): Promise<AzureFile> {
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
    const src = this.#baseUrl();
    const dst = new AzureFile(
      destKey(this.#prefix, dest, this.name),
      this.#account,
      this.#container,
      this.#auth,
      this.#url,
      this.#prefix,
    );
    const blobPath = `${accountPathPrefix(this.#url)}/${this.#container}/${encodePath(dst.path)}`;

    if (this.#auth.type === "shared-key") {
      const headers = await signAzure(
        "PUT",
        blobPath,
        { "x-ms-copy-source": src },
        { account: this.#account, key: this.#auth.key },
      );
      const res = await withAbortFetch(opts?.signal, dst.#baseUrl(), {
        method: "PUT",
        headers,
      });
      if (!res.ok)
        throw new BucketError(`Azure COPY error: ${res.status}`, {
          provider: "Azure",
          status: res.status,
        });
    } else {
      const token = await this.#auth.getToken();
      const res = await withAbortFetch(opts?.signal, dst.#baseUrl(), {
        method: "PUT",
        headers: {
          "x-ms-copy-source": src,
          "x-ms-date": new Date().toUTCString(),
          "x-ms-version": "2020-10-02",
          Authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok)
        throw new BucketError(`Azure COPY error: ${res.status}`, {
          provider: "Azure",
          status: res.status,
        });
    }
    return dst;
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
    const prefix = this.#prefix;
    const rel = prefix ? this.path.slice(prefix.length + 1) : this.path;
    const dir = rel.split("/").slice(0, -1).join("/");
    return this.moveTo(dir ? dir + "/" + name : name, opts);
  }

  async remove(opts?: ReadOptions): Promise<AzureFile> {
    throwIfAborted(opts?.signal);
    // "include" deletes the blob together with its snapshots; without it a
    // blob that has any snapshot refuses to delete at all (409). Versions are
    // untouched either way: this deletes the blob, never a `versionid`.
    const res = await this.#request(
      "DELETE",
      { "x-ms-delete-snapshots": "include" },
      undefined,
      opts?.signal,
    );
    // Already gone is success: removing a path twice is a no-op
    if (res.status === 404) return this;
    if (!res.ok && res.status !== 202)
      throw new BucketError(`Azure DELETE error: ${res.status}`, {
        provider: "Azure",
        status: res.status,
      });
    return this;
  }

  // Bun-style aliases, so muscle memory from Bun's S3File carries over
  unlink(opts?: ReadOptions): Promise<AzureFile> {
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
    const base = this.#publicUrl;
    return base ? publicUrlFrom(base, this.path) : this.#baseUrl();
  }

  async signedUrl(opts: { expires: number | string }): Promise<string | null> {
    if (this.#auth.type === "managed-identity") return null;
    const seconds = parse(opts.expires) ?? 3600;
    return presignAzure(
      this.#account,
      this.#container,
      this.path,
      this.#auth.key,
      "r",
      seconds,
    );
  }

  async uploadUrl(opts: { expires: number | string }): Promise<string | null> {
    if (this.#auth.type === "managed-identity") return null;
    const seconds = parse(opts.expires) ?? 3600;
    return presignAzure(
      this.#account,
      this.#container,
      this.path,
      this.#auth.key,
      "w",
      seconds,
    );
  }
}
