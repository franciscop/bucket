import cleanAndSignS3 from "../lib/cleanAndSignS3.ts";
import encodeS3Path from "../lib/encodeS3Path.ts";
import { escapeXml, unescapeXml, extractTags, getTag } from "../lib/xml.ts";
import { sha256base64 } from "../lib/webcrypto.ts";
import BucketError from "../lib/BucketError.ts";
import { fileKey, scope, folderKey } from "../lib/prefix.ts";
import { randomName } from "../lib/nanoid.ts";
import { assertFilter, requireFilter } from "../lib/filter.ts";
import {
  throwIfAborted,
  withAbortFetch,
  type ReadOptions,
} from "../lib/abort.ts";
import type {
  Bucket,
  BucketInfo,
  S3Auth,
  S3Request,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
import { R2File, type R2BucketContext } from "./File.ts";

const {
  R2_BUCKET: ENV_BUCKET,
  R2_URL: ENV_URL,
  R2_ACCOUNT_ID: ENV_ACCOUNT,
  R2_ACCESS_KEY_ID: ENV_ID,
  R2_SECRET_ACCESS_KEY: ENV_KEY,
  R2_SESSION_TOKEN: ENV_SESSION_TOKEN,
  R2_REGION: ENV_REGION,
  R2_PUBLIC_URL: ENV_PUBLIC_URL,
} = process.env;

export interface R2Config {
  id?: string;
  secret?: string;
  region?: string;
  sessionToken?: string;
  /** Cloudflare account id, which the endpoint is derived from (falls back
   * to `R2_ACCOUNT_ID`). This is the normal way to configure R2. */
  account?: string;
  /** Endpoint *without* the bucket, for custom endpoints and emulators (falls
   * back to `R2_URL`). The bucket name is appended as a path segment.
   * Derived from `account` when unset. */
  url?: string;
  /** Public base for `file.publicUrl()`: the bucket's `r2.dev` or custom
   * domain, e.g. `https://cdn.example.com` (falls back to `R2_PUBLIC_URL`).
   * Without it `publicUrl()` returns null, since R2's storage endpoint is
   * never publicly readable. */
  publicUrl?: string;
}

const endpointFor = (account: string) =>
  `https://${account}.r2.cloudflarestorage.com`;

class CloudflareR2Bucket implements Bucket {
  readonly type = "R2";
  private url: string;
  // The configured endpoint, kept apart from `url` (which has the bucket
  // appended) so folder() can rebuild without appending it twice.
  #endpoint: string;
  #publicUrl: string;
  #auth: S3Auth;
  private bucketName: string;
  PREFIX = "";

  constructor(
    name: string = ENV_BUCKET || "",
    {
      id = ENV_ID || "",
      secret = ENV_KEY || "",
      region = ENV_REGION || "auto",
      sessionToken = ENV_SESSION_TOKEN,
      account = ENV_ACCOUNT || "",
      url = ENV_URL || "",
      publicUrl = ENV_PUBLIC_URL || "",
    }: R2Config = {},
  ) {
    if (!name) {
      throw new BucketError(
        "R2 needs a bucket name, as the first argument or R2_BUCKET.",
        { code: "INVALID_CONFIG" },
      );
    }
    const custom = url.replace(/\/+$/, "");
    if (account && custom && custom !== endpointFor(account)) {
      throw new BucketError(
        `R2 account "${account}" implies the endpoint ${endpointFor(account)}, ` +
          `which does not match url "${custom}". Pass one or the other.`,
        { code: "INVALID_CONFIG" },
      );
    }
    if (!account && !custom) {
      throw new BucketError(
        "R2 needs an account id (or R2_ACCOUNT_ID) to build its endpoint, " +
          "or a url for a custom endpoint.",
        { code: "INVALID_CONFIG" },
      );
    }
    this.#endpoint = custom || endpointFor(account);
    this.#publicUrl = publicUrl.replace(/\/+$/, "");
    this.bucketName = name;
    // The endpoint excludes the bucket; R2 addresses it path-style.
    this.url = `${this.#endpoint}/${name}`;
    this.#auth = { id, secret, region, sessionToken };
  }

  private makeUrl(path: string = ""): string {
    const cleanPath = path ? (path.startsWith("/") ? path : "/" + path) : "";
    // Encode the key so the sent path matches what the signer canonicalizes.
    return this.url + encodeS3Path(cleanPath);
  }

  private async doRequest(
    method: string,
    path: string,
    options: { body?: string | Buffer; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const url = this.makeUrl(path);
    const req: S3Request = {
      url,
      method: method.toLowerCase(),
      headers: { ...(options.headers || {}) },
      body: options.body,
    };
    await cleanAndSignS3(req, this.#auth);
    const res = await fetch(url, {
      method: method.toUpperCase(),
      headers: req.headers,
      body: options.body as BodyInit | undefined,
    });
    if (process.env.DIAG)
      console.error(`[R2] ${method.toUpperCase()} ${url} -> ${res.status}`);
    return res;
  }

  async info(opts?: ReadOptions): Promise<BucketInfo> {
    throwIfAborted(opts?.signal);
    return {
      type: this.type,
      name: this.bucketName,
      url: this.url,
      id: this.#auth.id,
    };
  }

  private async *pages(
    filter?: RegExp,
    opts?: ReadOptions,
  ): AsyncGenerator<R2File[]> {
    let token: string | undefined;
    const s = scope(this.PREFIX, filter);

    do {
      const url = new URL(this.makeUrl(""));
      url.searchParams.set("list-type", "2");
      if (s.query) url.searchParams.set("prefix", s.query);
      if (token) url.searchParams.set("continuation-token", token);

      const req: S3Request = {
        url: url.toString(),
        method: "get",
        headers: {},
      };
      await cleanAndSignS3(req, this.#auth);

      const res = await withAbortFetch(opts?.signal, url.toString(), {
        method: "GET",
        headers: req.headers,
      });
      if (!res.ok)
        throw new BucketError(`R2 list error: ${res.status}`, {
          provider: "R2",
          status: res.status,
        });

      const xmlStr = await res.text();
      const page: R2File[] = [];
      for (const item of extractTags(xmlStr, "Contents")) {
        const key = unescapeXml(getTag(item, "Key"));
        if (!s.test(key)) continue;
        page.push(this.handle(key));
      }
      yield page;

      token =
        getTag(xmlStr, "IsTruncated") === "true"
          ? getTag(xmlStr, "NextContinuationToken")
          : undefined;
    } while (token);
  }

  scan(filter?: RegExp, opts?: ReadOptions): AsyncGenerator<R2File> {
    assertFilter(filter);
    // Eager, like the filter check: an aborted scan must not wait for the
    // first iteration to reject.
    throwIfAborted(opts?.signal);
    return this.#scan(filter, opts);
  }

  async *#scan(filter?: RegExp, opts?: ReadOptions): AsyncGenerator<R2File> {
    for await (const page of this.pages(filter, opts)) {
      for (const file of page) {
        throwIfAborted(opts?.signal);
        yield file;
      }
    }
  }

  async list(filter?: RegExp, opts?: ReadOptions): Promise<R2File[]> {
    assertFilter(filter);
    throwIfAborted(opts?.signal);
    const files: R2File[] = [];
    for await (const page of this.pages(filter, opts)) files.push(...page);
    return files;
  }

  async remove(filter: RegExp, opts?: ReadOptions): Promise<R2File[]> {
    requireFilter(filter);
    throwIfAborted(opts?.signal);
    const files = await this.list(filter, opts);
    if (!files.length) return [];

    const deleted: R2File[] = [];
    for (let i = 0; i < files.length; i += 1000) {
      const batch = files.slice(i, i + 1000);
      const body =
        `<Delete>` +
        batch
          .map((f) => `<Object><Key>${escapeXml(f.path)}</Key></Object>`)
          .join("") +
        `</Delete>`;

      const url = new URL(this.makeUrl(""));
      url.searchParams.set("delete", "");
      // DeleteObjects requires a body integrity header; S3/R2/MinIO 400 without it.
      const req: S3Request = {
        url: url.toString(),
        method: "post",
        headers: { "x-amz-checksum-sha256": await sha256base64(body) },
        body,
      };
      await cleanAndSignS3(req, this.#auth);

      const res = await withAbortFetch(opts?.signal, url.toString(), {
        method: "POST",
        headers: req.headers,
        body,
      });
      if (!res.ok)
        throw new BucketError(
          `R2 delete error: ${res.status} ${await res.text()}`,
          { provider: "R2", status: res.status },
        );

      const xmlStr = await res.text();
      const keys = extractTags(xmlStr, "Deleted").map((d) =>
        unescapeXml(getTag(d, "Key")),
      );
      deleted.push(...batch.filter((f) => keys.includes(f.path)));
    }

    return deleted;
  }

  private handle(path: string): R2File {
    const ctx: R2BucketContext = {
      makeUrl: (p) => this.makeUrl(p),
      doRequest: (m, p, opts) => this.doRequest(m, p, opts),
      getAuth: () => this.#auth,
      bucketName: this.bucketName,
      url: this.url,
      publicUrl: this.#publicUrl,
      prefix: this.PREFIX,
    };
    return new R2File(path, ctx);
  }

  file(name: string): R2File {
    if (!name) throw new Error("No name");
    return this.handle(fileKey(this.PREFIX, name));
  }

  async create(content: WriteContent, options?: WriteOptions): Promise<R2File> {
    throwIfAborted(options?.signal);
    return this.file(randomName(content, options)).write(content, options);
  }

  folder(path: string): CloudflareR2Bucket {
    const b = new CloudflareR2Bucket(this.bucketName, {
      url: this.#endpoint,
      publicUrl: this.#publicUrl,
    });
    b.#auth = this.#auth;
    b.PREFIX = folderKey(this.PREFIX, path);
    return b;
  }

  async count(filter?: RegExp, opts?: ReadOptions): Promise<number> {
    assertFilter(filter);
    return (await this.list(filter, opts)).length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<R2File> {
    yield* this.scan();
  }
}

/**
 * Create a Cloudflare R2 bucket handle.
 *
 * @param name - Bucket name (falls back to `R2_BUCKET` env var)
 * @param config.id - Access Key ID (falls back to `R2_ACCESS_KEY_ID`)
 * @param config.secret - Secret Access Key (falls back to `R2_SECRET_ACCESS_KEY`)
 * @param config.sessionToken - Session token for temporary credentials (falls back to `R2_SESSION_TOKEN`)
 * @param config.region - Region, default `"auto"` (falls back to `R2_REGION`)
 * @param config.account - Cloudflare account id the endpoint is derived from (falls back to `R2_ACCOUNT_ID`)
 * @param config.url - Endpoint without the bucket, for custom endpoints (falls back to `R2_URL`)
 * @param config.publicUrl - Public origin for `file.publicUrl()` (falls back to `R2_PUBLIC_URL`)
 *
 * @example
 * const bucket = CloudflareR2("my-bucket", {
 *   id: "keyId",
 *   secret: "secretKey",
 *   account: "abc123",
 * });
 * await bucket.file("hello.txt").write("hello");
 */
export default function CloudflareR2(
  name?: string,
  config?: R2Config,
): CloudflareR2Bucket {
  return new CloudflareR2Bucket(name, config);
}

export type {
  Bucket,
  BucketFile,
  FileInfo,
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
