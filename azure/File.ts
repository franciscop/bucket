import { Readable, Writable } from "node:stream";
import {
  signAzure,
  presignAzure,
  accountPathPrefix,
} from "../lib/signAzure.ts";
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
} from "../lib/types.ts";

export type AzureFileAuth =
  | { type: "shared-key"; key: string }
  | { type: "managed-identity"; getToken: () => Promise<string> };

export class AzureFile implements BucketFile {
  id: string;
  name: string;
  path: string;
  #account: string;
  #container: string;
  #url: string;
  #auth: AzureFileAuth;
  #range: ByteRange | null = null;

  constructor(
    path: string,
    account: string,
    container: string,
    auth: AzureFileAuth,
    url: string = `https://${account}.blob.core.windows.net`,
  ) {
    this.path = path.startsWith("/") ? path.slice(1) : path;
    this.name = this.path.split("/").pop() || this.path;
    this.id = this.path;
    this.#account = account;
    this.#container = container;
    this.#url = url;
    this.#auth = auth;
  }

  slice(start: number, end?: number): AzureFile {
    const f = new AzureFile(
      this.path,
      this.#account,
      this.#container,
      this.#auth,
      this.#url,
    );
    f.#range = composeRange(this.#range, start, end);
    return f;
  }

  // A range-aware, status-checked GET used by every reader. Azure's SharedKey
  // StringToSign has no slot for a standard `Range` header, but it does sign
  // every `x-ms-*` header, so we use `x-ms-range`. An empty range resolves to
  // an empty body without hitting the network.
  async #get(): Promise<Response> {
    if (this.#range && isEmptyRange(this.#range))
      return new Response(new Uint8Array(0));
    const rh = this.#range && rangeHeader(this.#range);
    const res = await this.#request("GET", rh ? { "x-ms-range": rh } : {});
    if (!res.ok)
      throw new BucketError(`Azure GET error: ${res.status}`, {
        provider: "Azure",
        status: res.status,
      });
    return res;
  }

  #baseUrl(): string {
    return `${this.#url}/${this.#container}/${this.path}`;
  }

  async #request(
    method: string,
    extraHeaders: Record<string, string> = {},
    body?: string | Buffer,
  ): Promise<Response> {
    const blobPath = `${accountPathPrefix(this.#url)}/${this.#container}/${this.path}`;
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
      return fetch(this.#baseUrl(), {
        method,
        headers,
        body: body as BodyInit | undefined,
      });
    }

    const token = await this.#auth.getToken();
    return fetch(this.#baseUrl(), {
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

  async info(): Promise<FileInfo> {
    const res = await this.#request("HEAD");
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
      throw new BucketError(`Azure HEAD error: ${res.status}`, {
        provider: "Azure",
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
      metadata: metaFromHeaders(res.headers, "x-ms-meta-"),
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
    const extraHeaders: Record<string, string> = {
      "x-ms-blob-type": "BlockBlob",
    };
    const type = options.type ?? getContentType(this.path);
    if (type) extraHeaders["x-ms-blob-content-type"] = type;
    if (options.cacheControl)
      extraHeaders["x-ms-blob-cache-control"] = options.cacheControl;
    if (options.disposition)
      extraHeaders["x-ms-blob-content-disposition"] = options.disposition;
    if (options.metadata) {
      for (const [k, v] of Object.entries(options.metadata)) {
        extraHeaders[`x-ms-meta-${k.toLowerCase()}`] = v;
      }
    }
    const res = await this.#request("PUT", extraHeaders, data);
    if (!res.ok)
      throw new BucketError(`Azure PUT error: ${res.status}`, {
        provider: "Azure",
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
    if (content instanceof AzureFile)
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
    const src = this.#baseUrl();
    const dst = new AzureFile(
      dest,
      this.#account,
      this.#container,
      this.#auth,
      this.#url,
    );
    const blobPath = `${accountPathPrefix(this.#url)}/${this.#container}/${dst.path}`;

    if (this.#auth.type === "shared-key") {
      const headers = await signAzure(
        "PUT",
        blobPath,
        { "x-ms-copy-source": src },
        { account: this.#account, key: this.#auth.key },
      );
      const res = await fetch(dst.#baseUrl(), { method: "PUT", headers });
      if (!res.ok)
        throw new BucketError(`Azure COPY error: ${res.status}`, {
          provider: "Azure",
          status: res.status,
        });
    } else {
      const token = await this.#auth.getToken();
      const res = await fetch(dst.#baseUrl(), {
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
    const res = await this.#request("DELETE");
    if (!res.ok && res.status !== 202)
      throw new BucketError(`Azure DELETE error: ${res.status}`, {
        provider: "Azure",
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
    return this.#baseUrl();
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
