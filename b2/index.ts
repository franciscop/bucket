import type { Bucket, BucketInfo } from "../lib/types.ts";
import { withPrefix, scope, subBucket } from "../lib/prefix.ts";
import BucketError from "../lib/BucketError.ts";
import { B2File, type B2BucketContext } from "./File.ts";

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

class BackBlazeInstance implements Bucket, B2BucketContext {
  readonly type = "BACKBLAZE";
  id!: string;
  name!: string;
  token!: string;
  apiBase!: string;
  base!: string;
  PREFIX = "";
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
      type: this.type,
      name: this.name,
      endpoint: this.base,
      id: this.id,
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
        throw new BucketError(`[${status}] "${code}" on ${path}\n${message}`, {
          provider: "BACKBLAZE",
          status,
        });
      } else {
        throw new BucketError(
          `Error ${res.status}: ${path}\n${await res.text()}`,
          { provider: "BACKBLAZE", status: res.status },
        );
      }
    }
    return res;
  }

  file(name: string): B2File {
    if (!name) throw new Error("No name");
    return new B2File(withPrefix(this.PREFIX, name), this);
  }

  folder(path: string): BackBlazeInstance {
    return subBucket(this, path);
  }

  async count(filter?: RegExp): Promise<number> {
    return (await this.list(filter)).length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<B2File> {
    yield* this.scan();
  }

  private async *pages(filter?: RegExp): AsyncGenerator<B2File[]> {
    await this.initPromise;
    let nextFileName: string | undefined;
    const s = scope(this.PREFIX, filter);

    do {
      let url =
        this.apiBase +
        "b2_list_file_names?bucketId=" +
        encodeURIComponent(this.id);
      if (s.query) url += "&prefix=" + encodeURIComponent(s.query);
      if (nextFileName)
        url += "&startFileName=" + encodeURIComponent(nextFileName);

      const res = await this.fetch(url);
      const data = (await res.json()) as {
        files: B2FileEntry[];
        nextFileName?: string;
      };

      const page: B2File[] = [];
      for (const fileData of data.files) {
        if (!s.test(fileData.fileName)) continue;
        const f = new B2File(fileData.fileName, this);
        f.id = fileData.fileId;
        f.type = fileData.contentType;
        f.size = fileData.contentLength;
        f.date = new Date(fileData.uploadTimestamp);
        f.url = this.base + "file/" + this.name + "/" + fileData.fileName;
        page.push(f);
      }
      yield page;

      nextFileName = data.nextFileName;
    } while (nextFileName);
  }

  async *scan(filter?: RegExp): AsyncGenerator<B2File> {
    for await (const page of this.pages(filter)) yield* page;
  }

  async list(filter?: RegExp): Promise<B2File[]> {
    const files: B2File[] = [];
    for await (const page of this.pages(filter)) files.push(...page);
    return files;
  }

  async remove(filter?: RegExp): Promise<B2File[]> {
    const files = await this.list(filter);
    await Promise.all(files.map((file) => file.remove()));
    return files;
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

export type {
  Bucket,
  BucketFile,
  FileInfo,
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
