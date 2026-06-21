import { Readable, Writable } from "node:stream";
import parse from "../lib/parse.ts";
import { createHash } from "node:crypto";
import promiseToReadable from "../lib/promiseToReadable.ts";
import promiseToWritable from "../lib/promiseToWritable.ts";
import { getContentType } from "../lib/fileTypes.ts";
import type {
  IBucketFile,
  FileInfo,
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";

const hashString = (str: string | Buffer): string =>
  createHash("sha1")
    .update(str as string)
    .digest("hex");

export interface B2UploadAuth {
  uploadUrl: string;
  authorizationToken: string;
}

export interface B2BucketContext {
  info(): Promise<BucketInfo>;
  fetch(url: string, options?: RequestInit): Promise<Response>;
  apiBase: string;
  list(prefix: string): Promise<B2File[]>;
}

export class B2File implements IBucketFile {
  id: string;
  name: string;
  path: string;
  type?: string;
  size?: number;
  date?: Date;
  url?: string;
  #bucket: B2BucketContext;

  constructor(path: string, bucket: B2BucketContext) {
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

    // Detect from the extension like every other provider; fall back to B2's
    // server-side auto-detection ("b2/x-auto") only for unknown extensions.
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
      throw new Error("rename() cannot change directory, use moveTo() instead");
    const dir = this.path.split("/").slice(0, -1).join("/");
    await this.moveTo(dir ? dir + "/" + name : name);
  }

  async remove(): Promise<void> {
    const bucket = await this.#bucket.info();
    // B2 keeps one version per write, so a single delete can leave older
    // versions behind. List every version of this exact file in one call,
    // then delete them all in parallel (instead of re-listing after each
    // delete, which made bulk removes O(n) round-trips and time out).
    const res = await this.#bucket.fetch(
      this.#bucket.apiBase + "b2_list_file_versions",
      {
        method: "POST",
        body: JSON.stringify({
          bucketId: bucket.id,
          startFileName: this.path,
          prefix: this.path,
          maxFileCount: 1000,
        }),
        headers: { "Content-Type": "application/json" },
      },
    );
    const { files } = (await res.json()) as {
      files: { fileId: string; fileName: string }[];
    };
    const versions = files.filter((f) => f.fileName === this.path);

    const deleteUrl = this.#bucket.apiBase + "b2_delete_file_version";
    await Promise.all(
      versions.map((v) =>
        this.#bucket
          .fetch(deleteUrl, {
            method: "POST",
            body: JSON.stringify({ fileId: v.fileId, fileName: v.fileName }),
            headers: { "Content-Type": "application/json" },
          })
          .catch((e: Error) => {
            // Tolerate a concurrent delete of the same version
            if (!e.message.includes("file_not_present")) throw e;
          }),
      ),
    );
    this.id = "";
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
    return Writable.fromWeb(
      this.writable(options) as WritableStream<Uint8Array>,
    );
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
