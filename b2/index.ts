import "dotenv/config";

import { Readable, Writable } from "node:stream";
import parse from "../lib/parse.ts";
import { createHash } from "node:crypto";
import promiseToReadable from "../lib/promiseToReadable.ts";
import promiseToWritable from "../lib/promiseToWritable.ts";
import type {
  IBucket,
  IBucketFile,
  FileInfo,
  BucketInfo,
  WriteContent,
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
    if (files.length) {
      const f = files[0] as B2File;
      this.id = f.id;
      this.type = f.type;
      this.size = f.size;
      this.date = f.date;
      return {
        ...files[0],
        exists: true,
      } as unknown as FileInfo;
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
    return (await this.info()).size !== 0;
  }

  async #put(data: string | Buffer): Promise<void> {
    const bucket = await this.#bucket.info();
    const url =
      this.#bucket.apiBase + "b2_get_upload_url?bucketId=" + bucket.id;
    const res = await this.#bucket.fetch(url);
    const auth = (await res.json()) as B2UploadAuth;

    const headers: Record<string, string | number> = {
      Authorization: auth.authorizationToken,
      "X-Bz-File-Name": this.path,
      "X-Bz-Content-Sha1": hashString(data),
      "Content-Length": Buffer.byteLength(data as string),
      "Content-Type": "b2/x-auto",
    };
    const res2 = await this.#bucket.fetch(auth.uploadUrl, {
      body: data as BodyInit,
      method: "POST",
      headers: headers as Record<string, string>,
    });
    const uploaded = (await res2.json()) as { fileId: string };
    this.id = uploaded.fileId;
  }

  async write(content: WriteContent): Promise<void> {
    if (typeof content === "string") return this.#put(content);
    if (content instanceof Buffer || content instanceof Uint8Array)
      return this.#put(Buffer.from(content));
    if (content instanceof Blob) {
      return this.#put(Buffer.from(await content.arrayBuffer()));
    }
    if (content instanceof B2File) {
      return this.#put(Buffer.from(await content.arrayBuffer()));
    }
    if (typeof (content as ReadableStream).pipeTo === "function") {
      return (content as ReadableStream).pipeTo(this.writable());
    }
    if (content instanceof Readable) {
      return Readable.toWeb(content).pipeTo(this.writable());
    }
    throw new Error("Invalid content type");
  }

  async copy(path: string): Promise<void> {
    await new B2File(path, this.#bucket).write(this);
  }

  async move(path: string): Promise<void> {
    await this.copy(path);
    await this.remove();
  }

  async rename(name: string): Promise<void> {
    if (name.includes("/"))
      throw new Error("rename() cannot change directory — use move() instead");
    const dir = this.path.split("/").slice(0, -1).join("/");
    await this.move(dir ? dir + "/" + name : name);
  }

  async remove(): Promise<void> {
    const bucket = await this.#bucket.info();
    const url =
      this.#bucket.apiBase + "b2_delete_file_version?bucketId=" + bucket.id;
    do {
      if (!this.id) await this.info();
      await this.#bucket.fetch(url, {
        method: "POST",
        body: JSON.stringify({ fileId: this.id, fileName: this.path }),
        headers: { "Content-Type": "application/json" },
      });
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

  writable(): WritableStream {
    return promiseToWritable((data) => this.write(data));
  }

  nodeWritable(): NodeJS.WritableStream {
    return Writable.fromWeb(this.writable() as WritableStream<Uint8Array>);
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

export default function BackBlaze(
  name?: string,
  opts?: { id?: string; secret?: string },
): BackBlazeInstance {
  return new BackBlazeInstance(name, opts);
}

export { BackBlazeInstance };
