import "dotenv/config";

import { Readable, Writable } from "node:stream";
import { signAzure, presignAzure } from "../lib/signAzure.ts";
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
} from "../lib/types.ts";

const {
  AZURE_ACCOUNT: ENV_ACCOUNT,
  AZURE_CONTAINER: ENV_CONTAINER,
  AZURE_KEY: ENV_KEY,
} = process.env;

function extractXmlTags(xml: string, tag: string): string[] {
  const results: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) results.push(m[1]);
  return results;
}

function getXmlTag(xml: string, tag: string): string {
  return extractXmlTags(xml, tag)[0] ?? "";
}

class AzureFile implements IBucketFile {
  id: string;
  name: string;
  path: string;
  #account: string;
  #container: string;
  #key: string;

  constructor(path: string, account: string, container: string, key: string) {
    this.path = path.startsWith("/") ? path.slice(1) : path;
    this.name = this.path.split("/").pop() || this.path;
    this.id = this.path;
    this.#account = account;
    this.#container = container;
    this.#key = key;
  }

  #baseUrl(): string {
    return `https://${this.#account}.blob.core.windows.net/${this.#container}/${this.path}`;
  }

  async #request(
    method: string,
    extraHeaders: Record<string, string> = {},
    body?: string | Buffer,
  ): Promise<Response> {
    const blobPath = `/${this.#container}/${this.path}`;
    const headers = signAzure(
      method,
      blobPath,
      {
        ...extraHeaders,
        ...(body !== undefined
          ? { "Content-Length": String(Buffer.byteLength(body)) }
          : {}),
      },
      { account: this.#account, key: this.#key },
    );
    return fetch(this.#baseUrl(), {
      method,
      headers,
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
      };
    }
    if (!res.ok) throw new Error(`Azure HEAD error: ${res.status}`);
    return {
      id: this.id,
      name: this.name,
      path: this.path,
      exists: true,
      type: res.headers.get("content-type"),
      size: parseInt(res.headers.get("content-length") ?? "0", 10),
      date: new Date(res.headers.get("last-modified") ?? Date.now()),
      url: this.publicUrl(),
    };
  }

  async exists(): Promise<boolean> {
    return (await this.info()).exists;
  }

  async text(): Promise<string> {
    const res = await this.#request("GET");
    if (!res.ok) throw new Error(`Azure GET error: ${res.status}`);
    return res.text();
  }

  async json(): Promise<unknown> {
    const res = await this.#request("GET");
    if (!res.ok) throw new Error(`Azure GET error: ${res.status}`);
    return res.json();
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const res = await this.#request("GET");
    if (!res.ok) throw new Error(`Azure GET error: ${res.status}`);
    return res.arrayBuffer();
  }

  async blob(): Promise<Blob> {
    const res = await this.#request("GET");
    if (!res.ok) throw new Error(`Azure GET error: ${res.status}`);
    return res.blob();
  }

  async bytes(): Promise<Uint8Array> {
    return new Uint8Array(await this.arrayBuffer());
  }

  async #put(data: string | Buffer, options: WriteOptions = {}): Promise<void> {
    const extraHeaders: Record<string, string> = { "x-ms-blob-type": "BlockBlob" };
    const type = options.type ?? getContentType(this.path);
    if (type) extraHeaders["x-ms-blob-content-type"] = type;
    if (options.cacheControl) extraHeaders["x-ms-blob-cache-control"] = options.cacheControl;
    if (options.disposition) extraHeaders["x-ms-blob-content-disposition"] = options.disposition;
    if (options.metadata) {
      for (const [k, v] of Object.entries(options.metadata)) {
        extraHeaders[`x-ms-meta-${k}`] = v;
      }
    }
    const res = await this.#request("PUT", extraHeaders, data);
    if (!res.ok) throw new Error(`Azure PUT error: ${res.status}`);
  }

  async write(content: WriteContent, options?: WriteOptions): Promise<void> {
    if (typeof content === "string") return this.#put(content, options);
    if (content instanceof Buffer || content instanceof Uint8Array)
      return this.#put(Buffer.from(content), options);
    if (content instanceof Blob)
      return this.#put(Buffer.from(await content.arrayBuffer()), options);
    if (content instanceof AzureFile)
      return this.#put(Buffer.from(await content.arrayBuffer()), options);
    if (typeof (content as ReadableStream).pipeTo === "function")
      return (content as ReadableStream).pipeTo(this.writable(options));
    if (content instanceof Readable)
      return Readable.toWeb(content).pipeTo(this.writable(options));
    throw new Error("Invalid content type");
  }

  async copyTo(path: string): Promise<void> {
    const src = this.#baseUrl();
    const dst = new AzureFile(path, this.#account, this.#container, this.#key);
    const blobPath = `/${this.#container}/${dst.path}`;
    const headers = signAzure(
      "PUT",
      blobPath,
      { "x-ms-copy-source": src },
      { account: this.#account, key: this.#key },
    );
    const res = await fetch(dst.#baseUrl(), { method: "PUT", headers });
    if (!res.ok) throw new Error(`Azure COPY error: ${res.status}`);
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
    const res = await this.#request("DELETE");
    if (!res.ok && res.status !== 202)
      throw new Error(`Azure DELETE error: ${res.status}`);
  }

  stream(): ReadableStream {
    return promiseToReadable(async () => {
      const res = await this.#request("GET");
      if (!res.ok) throw new Error(`Azure GET error: ${res.status}`);
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
    return Writable.fromWeb(this.writable(options) as unknown as WritableStream<Uint8Array>);
  }

  publicUrl(): string {
    return this.#baseUrl();
  }

  async signedUrl(opts: { expires: number | string }): Promise<string> {
    const seconds = parse(opts.expires) ?? 3600;
    return presignAzure(this.#account, this.#container, this.path, this.#key, "r", seconds);
  }

  async uploadUrl(opts: { expires: number | string }): Promise<string> {
    const seconds = parse(opts.expires) ?? 3600;
    return presignAzure(this.#account, this.#container, this.path, this.#key, "w", seconds);
  }
}

class AzureBucket implements IBucket {
  readonly type = "AZURE";
  #account: string;
  #container: string;
  #key: string;

  constructor(
    account: string = ENV_ACCOUNT || "",
    container: string = ENV_CONTAINER || "",
    key: string = ENV_KEY || "",
  ) {
    this.#account = account;
    this.#container = container;
    this.#key = key;
  }

  async info(): Promise<BucketInfo> {
    return {
      id: this.#account,
      name: this.#container,
      type: this.type,
      endpoint: `https://${this.#account}.blob.core.windows.net/${this.#container}`,
    };
  }

  async list(filter?: string | RegExp): Promise<AzureFile[]> {
    const files: AzureFile[] = [];
    let marker: string | undefined;

    do {
      const containerPath = `/${this.#container}`;
      const params: Record<string, string> = {
        restype: "container",
        comp: "list",
        ...(typeof filter === "string" && filter ? { prefix: filter } : {}),
        ...(marker ? { marker } : {}),
      };
      const query = new URLSearchParams(params).toString();
      const url = `https://${this.#account}.blob.core.windows.net/${this.#container}?${query}`;

      const headers = signAzure(
        "GET",
        containerPath,
        {},
        { account: this.#account, key: this.#key },
        params,
      );
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`Azure list error: ${res.status}`);

      const xml = await res.text();
      for (const item of extractXmlTags(xml, "Blob")) {
        const name = getXmlTag(item, "Name");
        if (filter instanceof RegExp && !filter.test(name)) continue;
        files.push(new AzureFile(name, this.#account, this.#container, this.#key));
      }

      marker = getXmlTag(xml, "NextMarker") || undefined;
    } while (marker);

    return files;
  }

  file(name: string): AzureFile {
    if (!name) throw new Error("No name");
    return new AzureFile(name, this.#account, this.#container, this.#key);
  }

  async remove(filter?: string | RegExp): Promise<AzureFile[]> {
    const files = await this.list(filter);
    await Promise.all(files.map((f) => f.remove()));
    return files;
  }

  async count(filter?: string | RegExp): Promise<number> {
    return (await this.list(filter)).length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AzureFile> {
    for (const file of await this.list()) yield file;
  }
}

/**
 * Create an Azure Blob Storage container handle.
 *
 * @param account - Storage account name (falls back to `AZURE_ACCOUNT` env var)
 * @param container - Container name (falls back to `AZURE_CONTAINER`)
 * @param key - Base64-encoded storage account key (falls back to `AZURE_KEY`)
 *
 * @example
 * const bucket = Azure("myaccount", "mycontainer", "base64key==");
 * await bucket.file("hello.txt").write("hello");
 */
export default function Azure(
  account?: string,
  container?: string,
  key?: string,
): AzureBucket {
  return new AzureBucket(account, container, key);
}

export { AzureBucket, AzureFile };
