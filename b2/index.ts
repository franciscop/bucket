import "dotenv/config";

import { Readable, Writable } from "node:stream";
import parse from "../lib/parse.ts";
import { createHash } from "node:crypto";
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

const hashString = (str: string | Buffer): string => {
  return createHash("sha1")
    .update(str as string)
    .digest("hex");
};

const API_VERSION_URL = "/b2api/v2/";

const {
  B2_BUCKET: ENV_NAME,
  B2_APPLICATION_KEY_ID: ENV_ID,
  B2_APPLICATION_KEY: ENV_KEY,
} = process.env;

interface B2FileEntry {
  fileName: string;
  fileId: string;
  contentType: string;
  contentLength: number;
  uploadTimestamp: number;
}

interface B2UploadAuth {
  uploadUrl: string;
  authorizationToken: string;
}

class B2File implements IBucketFile {
  id: string;
  name: string;
  path: string;
  type?: string;
  size?: number;
  date?: Date;
  url?: string;
  #bucket: BackBlazeInstance;

  constructor(path: string, bucket: BackBlazeInstance) {
    this.id = "";
    this.name = path.split("/").pop()!;
    this.path = path;
    this.#bucket = bucket;
  }

  async info(): Promise<FileInfo> {
    const files = await this.#bucket.list(this.path);
    const match = (files as B2File[]).find((f) => f.path === this.path);
    if (match) {
      this.id = match.id;
      this.type = match.type;
      this.size = match.size;
      this.date = match.date;
      return {
        id: match.id,
        name: match.name,
        path: match.path,
        exists: true,
        type: match.type ?? null,
        size: match.size ?? 0,
        date: match.date ?? null,
        url: match.url ?? null,
      };
    }
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

  async text(): Promise<string> {
    const bucket = await this.#bucket.info();
    const url = bucket.base + "file/" + bucket.name + "/" + this.path;
    const res = await this.#bucket.fetch(url);
    return res.text();
  }

  async json(): Promise<unknown> {
    const bucket = await this.#bucket.info();
    const url = bucket.base + "file/" + bucket.name + "/" + this.path;
    const res = await this.#bucket.fetch(url);
    return res.json();
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const bucket = await this.#bucket.info();
    const url = bucket.base + "file/" + bucket.name + "/" + this.path;
    const res = await this.#bucket.fetch(url);
    return res.arrayBuffer();
  }

  async blob(): Promise<Blob> {
    const bucket = await this.#bucket.info();
    const url = bucket.base + "file/" + bucket.name + "/" + this.path;
    const res = await this.#bucket.fetch(url);
    return res.blob();
  }

  async bytes(): Promise<Uint8Array> {
    return new Uint8Array(await this.arrayBuffer());
  }

  async exists(): Promise<boolean> {
    return (await this.info()).exists;
  }

  async #put(data: string | Buffer, options: WriteOptions = {}): Promise<void> {
    const bucket = await this.#bucket.info();
    const url =
      this.#bucket.apiBase + "b2_get_upload_url?bucketId=" + bucket.id;
    const res = await this.#bucket.fetch(url);
    const auth = (await res.json()) as B2UploadAuth;

    const type = options.type ?? getContentType(this.path) ?? "b2/x-auto";
    const headers: Record<string, string | number> = {
      Authorization: auth.authorizationToken,
      "X-Bz-File-Name": this.path,
      "X-Bz-Content-Sha1": hashString(data),
      "Content-Length": Buffer.byteLength(data as string),
      "Content-Type": type,
    };
    if (options.cacheControl)
      headers["X-Bz-Info-b2-cache-control"] = options.cacheControl;
    if (options.disposition)
      headers["X-Bz-Info-b2-content-disposition"] = options.disposition;
    if (options.metadata) {
      for (const [k, v] of Object.entries(options.metadata)) {
        headers[`X-Bz-Info-${k}`] = v;
      }
    }
    const res2 = await this.#bucket.fetch(auth.uploadUrl, {
      body: data as BodyInit,
      method: "POST",
      headers: headers as Record<string, string>,
    });
    const uploaded = (await res2.json()) as { fileId: string };
    this.id = uploaded.fileId;
  }

  async write(content: WriteContent, options?: WriteOptions): Promise<void> {
    if (typeof content === "string") return this.#put(content, options);
    if (content instanceof Buffer || content instanceof Uint8Array)
      return this.#put(Buffer.from(content), options);
    if (content instanceof Blob)
      return this.#put(Buffer.from(await content.arrayBuffer()), options);
    if (content instanceof B2File)
      return this.#put(Buffer.from(await content.arrayBuffer()), options);
    if (typeof (content as ReadableStream).pipeTo === "function")
      return (content as ReadableStream).pipeTo(this.writable(options));
    if (content instanceof Readable)
      return Readable.toWeb(content).pipeTo(this.writable(options));
    throw new Error("Invalid content type");
  }

  async copyTo(path: string): Promise<void> {
    await new B2File(path, this.#bucket).write(this);
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
    const bucket = await this.#bucket.info();
    const url =
      this.#bucket.apiBase + "b2_delete_file_version?bucketId=" + bucket.id;
    do {
      if (!this.id) await this.info();
      if (!this.id) break; // file no longer exists
      try {
        await this.#bucket.fetch(url, {
          method: "POST",
          body: JSON.stringify({ fileId: this.id, fileName: this.path }),
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        if ((e as Error).message.includes("file_not_present")) break;
        throw e;
      }
      this.id = "";
    } while (await this.exists());
  }

  stream(): ReadableStream {
    return promiseToReadable(async () => {
      const bucket = await this.#bucket.info();
      const url = bucket.base + "file/" + bucket.name + "/" + this.path;
      const res = await this.#bucket.fetch(url);
      return res.body as unknown as ReadableStream;
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
    return Writable.fromWeb(this.writable(options) as WritableStream<Uint8Array>);
  }

  publicUrl(): string | null {
    return this.url ?? null;
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
      bucket.base +
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

class BackBlazeInstance implements IBucket {
  readonly type = "BACKBLAZE";
  id!: string;
  name!: string;
  token!: string;
  apiBase!: string;
  base!: string;
  private initPromise: Promise<void>;

  constructor(
    name: string = ENV_NAME || "",
    {
      id = ENV_ID || "",
      secret = ENV_KEY || "",
    }: { id?: string; secret?: string } = {},
  ) {
    this.name = name;
    this.initPromise = (async () => {
      const derived = Buffer.from(id + ":" + secret).toString("base64");
      // Use fetch directly to avoid circular dependency during init
      const res = await fetch(
        "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
        { headers: { Authorization: "Basic " + derived } },
      );
      const data = (await res.json()) as {
        allowed: { bucketId: string };
        authorizationToken: string;
        apiUrl: string;
        downloadUrl: string;
      };
      this.id = data.allowed.bucketId;
      this.token = data.authorizationToken;
      this.apiBase = data.apiUrl + API_VERSION_URL;
      this.base = data.downloadUrl.replace(/\/$/, "") + "/";
    })();
  }

  async info(): Promise<BucketInfo> {
    await this.initPromise;
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      base: this.base,
    };
  }

  async fetch(url: string, options: RequestInit = {}): Promise<Response> {
    await this.initPromise;
    const headers = { Authorization: this.token };
    const res = await fetch(url, {
      ...options,
      headers: { ...headers, ...(options.headers as Record<string, string>) },
    });
    if (!res.ok) {
      const path = url.split(".com").pop();
      if (res.headers.get("content-type")?.includes("application/json")) {
        const { status, code, message } = (await res.json()) as {
          status: number;
          code: string;
          message: string;
        };
        throw new Error(`[${status}] "${code}" on ${path}\n${message}`);
      } else {
        throw new Error(`Error ${res.status}: ${path}\n${await res.text()}`);
      }
    }
    return res;
  }

  file(name: string): B2File {
    if (!name) throw new Error("No name");
    return new B2File(name, this);
  }

  async count(filter?: string | RegExp): Promise<number> {
    return (await this.list(filter)).length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<B2File> {
    for (const file of await this.list()) {
      yield file;
    }
  }

  async list(prefix: string | RegExp = ""): Promise<B2File[]> {
    await this.initPromise;
    const files: B2File[] = [];
    let nextFileName: string | undefined;

    do {
      let url =
        this.apiBase +
        "b2_list_file_names?bucketId=" +
        encodeURIComponent(this.id);
      if (prefix && typeof prefix === "string")
        url += "&prefix=" + encodeURIComponent(prefix);
      if (nextFileName)
        url += "&startFileName=" + encodeURIComponent(nextFileName);

      const res = await this.fetch(url);
      const data = (await res.json()) as {
        files: B2FileEntry[];
        nextFileName?: string;
      };

      for (const fileData of data.files) {
        if (prefix instanceof RegExp && !prefix.test(fileData.fileName))
          continue;
        const f = new B2File(fileData.fileName, this);
        f.id = fileData.fileId;
        f.type = fileData.contentType;
        f.size = fileData.contentLength;
        f.date = new Date(fileData.uploadTimestamp);
        f.url = this.base + "file/" + this.name + "/" + fileData.fileName;
        files.push(f);
      }

      nextFileName = data.nextFileName;
    } while (nextFileName);

    return files;
  }

  async remove(filter?: string | RegExp): Promise<B2File[]> {
    const files = await this.list(filter ?? "");
    const deleted: B2File[] = [];
    for (const file of files) {
      await file.remove();
      deleted.push(file);
    }
    return deleted;
  }
}

/**
 * Create a Backblaze B2 bucket handle.
 *
 * @param name - Bucket name (falls back to `B2_BUCKET` env var)
 * @param opts.id - Application Key ID (falls back to `B2_APPLICATION_KEY_ID`)
 * @param opts.secret - Application Key (falls back to `B2_APPLICATION_KEY`)
 *
 * @example
 * const bucket = BackBlaze("my-bucket", { id: "keyId", secret: "appKey" });
 * await bucket.file("hello.txt").write("hello");
 */
export default function BackBlaze(
  name?: string,
  opts?: { id?: string; secret?: string },
): BackBlazeInstance {
  return new BackBlazeInstance(name, opts);
}

export { BackBlazeInstance };
