import type { Bucket, BucketInfo } from "../lib/types.ts";
import { fileKey, scope, folderKey } from "../lib/prefix.ts";
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

interface B2Auth {
  bucketId: string;
  token: string;
  apiBase: string;
  base: string;
  absoluteMinimumPartSize: number;
}

interface B2Config {
  id?: string;
  secret?: string;
  /** Authenticate immediately in the constructor (the default). folder()
   * clones pass `false` and adopt the parent's resolved auth instead, so a
   * folder never triggers its own network round-trip. */
  eager?: boolean;
}

async function authorize(id: string, secret: string): Promise<B2Auth> {
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
    absoluteMinimumPartSize?: number;
  };
  return {
    bucketId: data.allowed.bucketId,
    token: data.authorizationToken,
    apiBase: data.apiUrl + API_VERSION_URL,
    base: data.downloadUrl.replace(/\/$/, "") + "/",
    absoluteMinimumPartSize: data.absoluteMinimumPartSize ?? 5 * 1024 * 1024,
  };
}

class BackBlazeInstance implements Bucket {
  readonly type = "BACKBLAZE";
  name: string;
  // Non-secret connection details, mirrored from the resolved auth so
  // publicUrl() and B2File can read them synchronously. The bearer token
  // lives only inside #auth (never mirrored), so console.log(bucket) is safe.
  id = "";
  apiBase = "";
  base = "";
  PREFIX = "";
  #auth!: Promise<B2Auth>;
  // What B2File needs from its bucket, kept off the public class surface.
  #ctx: B2BucketContext;

  constructor(name: string = ENV_NAME || "", config: B2Config = {}) {
    const { id = ENV_ID || "", secret = ENV_KEY || "", eager = true } = config;
    this.name = name;
    if (eager) this.#adopt(authorize(id, secret));
    const self = this;
    this.#ctx = {
      info: () => self.info(),
      fetch: (url, options) => self.fetch(url, options),
      // Part size for chunked (large file) uploads. B2's recommendedPartSize
      // is ~100 MB, far too much to buffer per part, so we use our own 8 MiB
      // default and only defer to B2 when its absolute minimum is higher.
      partSize: async () => {
        const auth = await self.#auth;
        return Math.max(auth.absoluteMinimumPartSize, 8 * 1024 * 1024);
      },
      get apiBase() {
        return self.apiBase;
      },
      get PREFIX() {
        return self.PREFIX;
      },
    };
  }

  // Store the auth promise and mirror its non-secret fields onto this instance.
  #adopt(auth: Promise<B2Auth>): void {
    this.#auth = auth;
    auth
      .then((a) => {
        this.id = a.bucketId;
        this.apiBase = a.apiBase;
        this.base = a.base;
      })
      .catch(() => {
        // Swallow here; the rejection resurfaces wherever #auth is awaited.
      });
  }

  async info(): Promise<BucketInfo> {
    await this.#auth;
    return {
      type: this.type,
      name: this.name,
      url: this.base,
      id: this.id,
    };
  }

  async fetch(url: string, options: RequestInit = {}): Promise<Response> {
    const { token } = await this.#auth;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: token,
        ...(options.headers as Record<string, string>),
      },
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
    return new B2File(fileKey(this.PREFIX, name), this.#ctx);
  }

  folder(path: string): BackBlazeInstance {
    const b = new BackBlazeInstance(this.name, { eager: false });
    b.#adopt(this.#auth);
    b.PREFIX = folderKey(this.PREFIX, path);
    return b;
  }

  async count(filter?: RegExp): Promise<number> {
    return (await this.list(filter)).length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<B2File> {
    yield* this.scan();
  }

  private async *pages(filter?: RegExp): AsyncGenerator<B2File[]> {
    await this.#auth;
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
        page.push(new B2File(fileData.fileName, this.#ctx));
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
