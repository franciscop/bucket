import type { IBucket, BucketInfo } from "../lib/types.ts";
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

class BackBlazeInstance implements IBucket, B2BucketContext {
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

export { BackBlazeInstance, B2File };

export type {
  FileInfo,
  BucketInfo,
  FileEntry,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
