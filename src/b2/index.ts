import { scope } from "../lib/prefix.ts";
import { throwIfAborted, withAbort, type ReadOptions } from "../lib/abort.ts";
import BucketError from "../lib/BucketError.ts";
import { BaseBucket } from "../lib/base.ts";
import type { BucketInfo } from "../lib/types.ts";
import { B2File, type B2Context } from "./File.ts";

const API_VERSION_URL = "/b2api/v2/";

const {
  B2_BUCKET: ENV_NAME,
  B2_APPLICATION_KEY_ID: ENV_ID,
  B2_APPLICATION_KEY: ENV_KEY,
  B2_PUBLIC_URL: ENV_PUBLIC_URL,
} = process.env;

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
  /** Public origin the bucket is served from, e.g. a CDN in front of B2 (falls
   * back to `B2_PUBLIC_URL`). Used by `file.publicUrl()`. */
  publicUrl?: string;
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
    if (name && allowedName && name !== allowedName)
      authError(
        `B2 key is restricted to the bucket "${allowedName}", so it cannot be used for "${name}"`,
      );
    return { ...auth, bucketId: allowedId, bucketName: allowedName || name };
  }

  // A re-authorization already knows the id, so skip the lookup below.
  if (knownBucketId)
    return { ...auth, bucketId: knownBucketId, bucketName: name };

  // Otherwise the id has to be looked up by name, which needs both a name and
  // the listBuckets capability.
  if (!name)
    authError(
      "B2 needs a bucket name: this key is not restricted to a single bucket, so pass one to BackBlaze() or set B2_BUCKET",
    );
  if (data.allowed?.capabilities?.includes("listBuckets") === false)
    authError(
      `B2 cannot resolve the bucket "${name}": this key is not restricted to a bucket and lacks the "listBuckets" capability. Use a bucket-restricted key, or grant it listBuckets.`,
    );
  const url =
    apiBase +
    "b2_list_buckets?accountId=" +
    encodeURIComponent(data.accountId) +
    "&bucketName=" +
    encodeURIComponent(name);
  const listRes = await fetch(url, { headers: { Authorization: auth.token } });
  if (!listRes.ok)
    authError(
      `B2 cannot resolve the bucket "${name}": list buckets failed with ${listRes.status}`,
      listRes.status,
    );
  const { buckets } = (await listRes.json()) as {
    buckets?: { bucketId: string; bucketName: string }[];
  };
  const found = buckets?.find((b) => b.bucketName === name);
  if (!found)
    authError(
      `B2 bucket "${name}" does not exist, or this key cannot access it`,
    );
  return { ...auth, bucketId: found!.bucketId, bucketName: name };
}

// B2 authorization tokens expire after 24 hours, so a long-lived bucket has
// to re-authorize. The session lives in the context, which folder() copies by
// reference, so one refresh serves a bucket and every folder cloned from it.
interface B2Session {
  auth: Promise<B2Auth>;
  refresh(stale: Promise<B2Auth>): Promise<B2Auth>;
  /** Non-secret fields mirrored from the resolved auth, so publicUrl() and
   * B2File can read them synchronously. The token is never mirrored, so
   * console.log(bucket) stays safe. */
  mirror: { id: string; name: string; apiBase: string; base: string };
}

function makeSession(id: string, secret: string, name: string): B2Session {
  const session: B2Session = {
    auth: authorize(id, secret, name),
    mirror: { id: "", name, apiBase: "", base: "" },
    refresh(stale) {
      // Only the first caller to notice the stale token re-authorizes; any
      // other in-flight request awaits the replacement it started.
      if (session.auth === stale) {
        session.auth = adopt(
          stale
            .then((a) => authorize(id, secret, a.bucketName, a.bucketId))
            .catch(() => authorize(id, secret, name)),
        );
      }
      return session.auth;
    },
  };
  // Mirror the non-secret fields as soon as the auth resolves.
  const adopt = (p: Promise<B2Auth>) => {
    p.then((a) => {
      // A bucket-restricted key knows its own name, so adopt it when the
      // caller did not pass one.
      session.mirror = {
        id: a.bucketId,
        name: a.bucketName,
        apiBase: a.apiBase,
        base: a.base,
      };
    }).catch(() => {
      // Swallow here; the rejection resurfaces wherever the auth is awaited.
    });
    return p;
  };
  adopt(session.auth);
  return session;
}

function b2Context(session: B2Session, publicUrl: string): B2Context {
  const ctx: B2Context = {
    provider: "BACKBLAZE",
    prefix: "",
    publicUrl,
    apiBase: () => session.mirror.apiBase,
    info: async () => {
      await session.auth;
      const { name, base, id } = session.mirror;
      return { type: "BACKBLAZE", name, url: base, id };
    },
    // Part size for chunked (large file) uploads. B2's recommendedPartSize
    // is ~100 MB, far too much to buffer per part, so we use our own 8 MiB
    // default and only defer to B2 when its absolute minimum is higher.
    partSize: async () => {
      const auth = await session.auth;
      return Math.max(auth.absoluteMinimumPartSize, 8 * 1024 * 1024);
    },
    fetch: async (url, options = {}) => {
      const signal = options.signal ?? undefined;
      const send = (token: string): Promise<Response> =>
        withAbort(signal, () =>
          fetch(url, {
            ...options,
            headers: {
              Authorization: token,
              ...(options.headers as Record<string, string>),
            },
          }),
        );

      throwIfAborted(signal);
      const stale = session.auth;
      // An abort rejects here rather than returning a status, so the 401 retry
      // below never sees it: re-authorizing because the caller cancelled would
      // be a wasted round trip against a request nobody is waiting for.
      let res = await send((await stale).token);
      // A 401 on a 24h-old token just means it expired: re-authorize once and
      // retry. Skipped when the caller brought its own Authorization (B2 upload
      // URLs carry a separate token, which re-authorizing would not renew).
      const ownAuth = (options.headers as Record<string, string>)
        ?.Authorization;
      if (res.status === 401 && !ownAuth)
        res = await send((await session.refresh(stale)).token);
      if (!res.ok) {
        const path = url.split(".com").pop();
        if (res.headers.get("content-type")?.includes("application/json")) {
          const { status, code, message } = (await res.json()) as {
            status: number;
            code: string;
            message: string;
          };
          throw new BucketError(
            `[${status}] "${code}" on ${path}\n${message}`,
            {
              provider: "BACKBLAZE",
              status,
            },
          );
        }
        throw new BucketError(
          `Error ${res.status}: ${path}\n${await res.text()}`,
          { provider: "BACKBLAZE", status: res.status },
        );
      }
      return res;
    },
  };
  return ctx;
}

class BackBlazeInstance extends BaseBucket<B2Context, B2File> {
  readonly type = "BACKBLAZE";
  #session: B2Session;

  constructor(ctx: B2Context, session: B2Session) {
    super(ctx);
    this.#session = session;
  }

  // folder() copies the context, so it has to carry the session across too.
  folder(path: string): this {
    const next = super.folder(path) as BackBlazeInstance;
    next.#session = this.#session;
    return next as this;
  }

  /** Bucket name, adopted from the key when the caller passed none. */
  get name(): string {
    return this.#session.mirror.name;
  }
  get id(): string {
    return this.#session.mirror.id;
  }
  get apiBase(): string {
    return this.#session.mirror.apiBase;
  }
  get base(): string {
    return this.#session.mirror.base;
  }

  protected make(key: string): B2File {
    return new B2File(key, this.ctx);
  }

  fetch(url: string, options?: RequestInit): Promise<Response> {
    return this.ctx.fetch(url, options);
  }

  async info(opts?: ReadOptions): Promise<BucketInfo> {
    throwIfAborted(opts?.signal);
    return this.ctx.info();
  }

  protected async *pages(filter?: RegExp, opts?: ReadOptions) {
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
      const res = await this.ctx.fetch(url, { signal: opts?.signal });
      const data = (await res.json()) as {
        files: { fileName: string }[];
        nextFileName?: string;
      };
      yield data.files
        .filter((f) => s.test(f.fileName))
        .map((f) => this.make(f.fileName));
      nextFileName = data.nextFileName;
    } while (nextFileName);
  }
}

/**
 * Create a Backblaze B2 bucket handle.
 *
 * @param name - Bucket name (falls back to `B2_BUCKET` env var)
 * @param opts.id - Application Key ID (falls back to `B2_APPLICATION_KEY_ID`)
 * @param opts.secret - Application Key (falls back to `B2_APPLICATION_KEY`)
 * @param opts.publicUrl - Public origin for `file.publicUrl()` (falls back to `B2_PUBLIC_URL`)
 *
 * @example
 * const bucket = BackBlaze("my-bucket", { id: "keyId", secret: "appKey" });
 * await bucket.file("hello.txt").write("hello");
 */
export default function BackBlaze(
  name: string = ENV_NAME || "",
  {
    id = ENV_ID || "",
    secret = ENV_KEY || "",
    publicUrl = ENV_PUBLIC_URL || "",
  }: B2Config = {},
): BackBlazeInstance {
  const session = makeSession(id, secret, name);
  return new BackBlazeInstance(
    b2Context(session, publicUrl.replace(/\/+$/, "")),
    session,
  );
}

export type {
  Bucket,
  BucketFile,
  FileInfo,
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
