import type {
  Bucket,
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
import { fileKey, scope, folderKey } from "../lib/prefix.ts";
import { randomName } from "../lib/nanoid.ts";
import { assertFilter, requireFilter } from "../lib/filter.ts";
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
  bucketName: string;
  token: string;
  apiBase: string;
  base: string;
  absoluteMinimumPartSize: number;
}

// b2_authorize_account. `allowed` describes what the application key may do:
// a key restricted to one bucket names it, while master keys (and any key with
// account-wide access) leave bucketId/bucketName null and need a lookup.
interface B2AuthResponse {
  accountId: string;
  authorizationToken: string;
  apiUrl: string;
  downloadUrl: string;
  absoluteMinimumPartSize?: number;
  allowed: {
    capabilities?: string[];
    bucketId?: string | null;
    bucketName?: string | null;
    namePrefix?: string | null;
  };
}

const authError = (message: string, status?: number): never => {
  throw new BucketError(message, { provider: "BACKBLAZE", status });
};

interface B2Config {
  id?: string;
  secret?: string;
  /** Authenticate immediately in the constructor (the default). folder()
   * clones pass `false` and adopt the parent's resolved auth instead, so a
   * folder never triggers its own network round-trip. */
  eager?: boolean;
}

async function authorize(
  id: string,
  secret: string,
  name: string,
  knownBucketId = "",
): Promise<B2Auth> {
  const derived = Buffer.from(id + ":" + secret).toString("base64");
  // Use fetch directly to avoid circular dependency during init
  const res = await fetch(
    "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
    { headers: { Authorization: "Basic " + derived } },
  );
  if (!res.ok) authError(`B2 authorize error: ${res.status}`, res.status);
  const data = (await res.json()) as B2AuthResponse;
  const apiBase = data.apiUrl + API_VERSION_URL;
  const auth = {
    token: data.authorizationToken,
    apiBase,
    base: data.downloadUrl.replace(/\/$/, "") + "/",
    absoluteMinimumPartSize: data.absoluteMinimumPartSize ?? 5 * 1024 * 1024,
  };

  // A bucket-restricted key already tells us the bucket: use it, and make sure
  // it is the one that was asked for instead of silently working on another.
  const allowedId = data.allowed?.bucketId ?? "";
  const allowedName = data.allowed?.bucketName ?? "";
  if (allowedId) {
    if (name && allowedName && name !== allowedName) {
      authError(
        `B2 key is restricted to the bucket "${allowedName}", so it cannot be used for "${name}"`,
      );
    }
    return { ...auth, bucketId: allowedId, bucketName: allowedName || name };
  }

  // A re-authorization already knows the id, so skip the lookup below.
  if (knownBucketId)
    return { ...auth, bucketId: knownBucketId, bucketName: name };

  // Otherwise the id has to be looked up by name, which needs both a name and
  // the listBuckets capability.
  if (!name) {
    authError(
      "B2 needs a bucket name: this key is not restricted to a single bucket, so pass one to BackBlaze() or set B2_BUCKET",
    );
  }
  if (data.allowed?.capabilities?.includes("listBuckets") === false) {
    authError(
      `B2 cannot resolve the bucket "${name}": this key is not restricted to a bucket and lacks the "listBuckets" capability. Use a bucket-restricted key, or grant it listBuckets.`,
    );
  }
  const url =
    apiBase +
    "b2_list_buckets?accountId=" +
    encodeURIComponent(data.accountId) +
    "&bucketName=" +
    encodeURIComponent(name);
  const listRes = await fetch(url, { headers: { Authorization: auth.token } });
  if (!listRes.ok) {
    authError(
      `B2 cannot resolve the bucket "${name}": list buckets failed with ${listRes.status}`,
      listRes.status,
    );
  }
  const { buckets } = (await listRes.json()) as {
    buckets?: { bucketId: string; bucketName: string }[];
  };
  const found = buckets?.find((b) => b.bucketName === name);
  if (!found) {
    authError(
      `B2 bucket "${name}" does not exist, or this key cannot access it`,
    );
  }
  return { ...auth, bucketId: found!.bucketId, bucketName: name };
}

// B2 authorization tokens expire after 24 hours, so a long-lived bucket has
// to re-authorize. The token lives in a session shared by a bucket and every
// folder cloned from it, so one refresh serves all of them.
interface B2Session {
  auth: Promise<B2Auth>;
  refresh(stale: Promise<B2Auth>): Promise<B2Auth>;
}

function makeSession(
  id: string,
  secret: string,
  name: string,
  bucketId = "",
): B2Session {
  const session: B2Session = {
    auth: authorize(id, secret, name, bucketId),
    refresh(stale) {
      // Only the first caller to notice the stale token re-authorizes; any
      // other in-flight request awaits the replacement it started.
      if (session.auth === stale) {
        session.auth = stale
          .then((a) => authorize(id, secret, a.bucketName, a.bucketId))
          .catch(() => authorize(id, secret, name, bucketId));
      }
      return session.auth;
    },
  };
  return session;
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
  #session!: B2Session;
  // What B2File needs from its bucket, kept off the public class surface.
  #ctx: B2BucketContext;

  constructor(name: string = ENV_NAME || "", config: B2Config = {}) {
    const { id = ENV_ID || "", secret = ENV_KEY || "", eager = true } = config;
    this.name = name;
    if (eager) this.#adopt(makeSession(id, secret, name));
    const self = this;
    this.#ctx = {
      info: () => self.info(),
      fetch: (url, options) => self.fetch(url, options),
      // Part size for chunked (large file) uploads. B2's recommendedPartSize
      // is ~100 MB, far too much to buffer per part, so we use our own 8 MiB
      // default and only defer to B2 when its absolute minimum is higher.
      partSize: async () => {
        const auth = await self.#session.auth;
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

  // Store the session and mirror its non-secret fields onto this instance.
  #adopt(session: B2Session): void {
    this.#session = session;
    session.auth
      .then((a) => {
        this.id = a.bucketId;
        // A bucket-restricted key knows its own name, so adopt it when the
        // caller did not pass one.
        this.name = a.bucketName;
        this.apiBase = a.apiBase;
        this.base = a.base;
      })
      .catch(() => {
        // Swallow here; the rejection resurfaces wherever #auth is awaited.
      });
  }

  async info(): Promise<BucketInfo> {
    await this.#session.auth;
    return {
      type: this.type,
      name: this.name,
      url: this.base,
      id: this.id,
    };
  }

  async fetch(url: string, options: RequestInit = {}): Promise<Response> {
    const send = (token: string): Promise<Response> =>
      fetch(url, {
        ...options,
        headers: {
          Authorization: token,
          ...(options.headers as Record<string, string>),
        },
      });

    const stale = this.#session.auth;
    let res = await send((await stale).token);
    // A 401 on a 24h-old token just means it expired: re-authorize once and
    // retry. Skipped when the caller brought its own Authorization (B2 upload
    // URLs carry a separate token, which re-authorizing would not renew).
    const ownAuth = (options.headers as Record<string, string>)?.Authorization;
    if (res.status === 401 && !ownAuth) {
      res = await send((await this.#session.refresh(stale)).token);
    }
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

  async create(content: WriteContent, options?: WriteOptions): Promise<B2File> {
    return this.file(randomName(content, options)).write(content, options);
  }

  folder(path: string): BackBlazeInstance {
    const b = new BackBlazeInstance(this.name, { eager: false });
    b.#adopt(this.#session);
    b.PREFIX = folderKey(this.PREFIX, path);
    return b;
  }

  async count(filter?: RegExp): Promise<number> {
    assertFilter(filter);
    return (await this.list(filter)).length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<B2File> {
    yield* this.scan();
  }

  private async *pages(filter?: RegExp): AsyncGenerator<B2File[]> {
    await this.#session.auth;
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

  scan(filter?: RegExp): AsyncGenerator<B2File> {
    assertFilter(filter);
    return this.#scan(filter);
  }

  async *#scan(filter?: RegExp): AsyncGenerator<B2File> {
    for await (const page of this.pages(filter)) yield* page;
  }

  async list(filter?: RegExp): Promise<B2File[]> {
    assertFilter(filter);
    const files: B2File[] = [];
    for await (const page of this.pages(filter)) files.push(...page);
    return files;
  }

  async remove(filter: RegExp): Promise<B2File[]> {
    requireFilter(filter);
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
