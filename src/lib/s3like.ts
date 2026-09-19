// One implementation of the S3 wire protocol, used by S3 and R2. The two
// differ only in how their config resolves (see s3/index.ts and r2/index.ts)
// and in whether the storage endpoint doubles as a public URL.
import cleanAndSignS3 from "./cleanAndSignS3.ts";
import encodeS3Path from "./encodeS3Path.ts";
import { escapeXml, unescapeXml, extractTags, getTag } from "./xml.ts";
import { sha256base64 } from "./webcrypto.ts";
import { scope, destKey } from "./prefix.ts";
import { throwIfAborted, type ReadOptions } from "./abort.ts";
import { Http, type SendOptions } from "./http.ts";
import { presignS3 } from "./presignS3.ts";
import multipartS3 from "./multipartS3.ts";
import metaFromHeaders from "./meta.ts";
import { publicUrlFrom } from "./publicUrl.ts";
import { rangeHeader, rangeSize } from "./range.ts";
import { metaHeaders } from "./writeMeta.ts";
import { BaseBucket, BaseFile, expiresIn, type FileContext } from "./base.ts";
import type {
  BucketFile,
  BucketInfo,
  FileInfo,
  S3Auth,
  S3Request,
  WriteOptions,
} from "./types.ts";

export interface S3LikeConfig {
  /** "S3" or "R2": the `type` of the bucket and the label in errors. */
  type: string;
  name: string;
  region: string;
  /** Endpoint without the bucket; "" means AWS's virtual-hosted default. */
  endpoint: string;
  publicUrl: string;
  /** Static credentials, or null to resolve them lazily (instance metadata). */
  auth: S3Auth | null;
  /** Credentials resolver used when `auth` is null. */
  resolveAuth?: (region: string) => Promise<S3Auth & { expiry: number }>;
  /** Whether the storage endpoint is publicly readable (S3 yes, R2 never). */
  canonicalPublic: boolean;
}

/** Resolves credentials once and holds them until they expire. Lives in the
 * context, so every folder shares one cache instead of re-resolving. */
class AuthCache {
  #config: S3LikeConfig;
  #cached: (S3Auth & { expiry: number }) | null = null;

  constructor(config: S3LikeConfig) {
    this.#config = config;
  }

  async get(): Promise<S3Auth> {
    if (this.#config.auth) return this.#config.auth;
    if (this.#cached && Date.now() < this.#cached.expiry - 60_000)
      return this.#cached;
    this.#cached = await this.#config.resolveAuth!(this.#config.region);
    return this.#cached;
  }
}

export interface S3Context extends FileContext {
  config: S3LikeConfig;
  /** Endpoint with the bucket appended: the base every request is built on. */
  url: string;
  auth: AuthCache;
  http: Http;
}

/** Builds the context a bucket and its files share. */
export function s3Context(config: S3LikeConfig, prefix = ""): S3Context {
  // A custom endpoint is path-style (MinIO, Spaces, Ceph, R2): append the
  // bucket. Without one, AWS's virtual-hosted endpoint puts it in the host.
  const url = config.endpoint
    ? `${config.endpoint}/${config.name}`
    : `https://${config.name}.s3.${config.region}.amazonaws.com`;
  const auth = new AuthCache(config);
  return {
    provider: config.type,
    prefix,
    publicUrl: config.publicUrl,
    config,
    url,
    auth,
    http: new Http({
      provider: config.type,
      authorize: async (req) => {
        const signed: S3Request = {
          url: req.url,
          method: req.method.toLowerCase(),
          headers: req.headers,
          body: req.body,
        };
        await cleanAndSignS3(signed, await auth.get());
        return { ...req, headers: signed.headers };
      },
    }),
  };
}

const makeUrl = (ctx: S3Context, path = ""): string => {
  const clean = path ? (path.startsWith("/") ? path : "/" + path) : "";
  // Encode the key so the sent path matches what the signer canonicalizes.
  return ctx.url + encodeS3Path(clean);
};

export class S3LikeBucket extends BaseBucket<S3Context, S3LikeFile> {
  readonly type: string;

  constructor(ctx: S3Context) {
    super(ctx);
    this.type = ctx.provider;
  }

  protected make(key: string): S3LikeFile {
    return new S3LikeFile(key, this.ctx);
  }

  async info(opts?: ReadOptions): Promise<BucketInfo> {
    throwIfAborted(opts?.signal);
    return {
      type: this.type,
      name: this.ctx.config.name,
      url: this.ctx.url,
      id: (await this.ctx.auth.get()).id,
    };
  }

  protected async *pages(filter?: RegExp, opts?: ReadOptions) {
    let token: string | undefined;
    const s = scope(this.PREFIX, filter);
    do {
      throwIfAborted(opts?.signal);
      const url = new URL(makeUrl(this.ctx));
      url.searchParams.set("list-type", "2");
      if (s.query) url.searchParams.set("prefix", s.query);
      if (token) url.searchParams.set("continuation-token", token);
      const res = await this.ctx.http.send("GET", url.toString(), {
        signal: opts?.signal,
        what: "list",
      });
      const xml = await res.text();
      yield extractTags(xml, "Contents")
        .map((item) => unescapeXml(getTag(item, "Key")))
        .filter((key) => s.test(key))
        .map((key) => this.make(key));
      token =
        getTag(xml, "IsTruncated") === "true"
          ? getTag(xml, "NextContinuationToken")
          : undefined;
    } while (token);
  }

  // DeleteObjects: up to 1000 keys per request, returning the confirmed ones.
  protected async removeAll(files: S3LikeFile[], opts?: ReadOptions) {
    const deleted: S3LikeFile[] = [];
    for (let i = 0; i < files.length; i += 1000) {
      const batch = files.slice(i, i + 1000);
      const body =
        "<Delete>" +
        batch
          .map((f) => `<Object><Key>${escapeXml(f.path)}</Key></Object>`)
          .join("") +
        "</Delete>";
      const url = new URL(makeUrl(this.ctx));
      url.searchParams.set("delete", "");
      const res = await this.ctx.http.send("POST", url.toString(), {
        body,
        // Required body integrity header; S3/R2/MinIO 400 without it.
        headers: { "x-amz-checksum-sha256": await sha256base64(body) },
        signal: opts?.signal,
        what: "delete",
      });
      const keys = extractTags(await res.text(), "Deleted").map((d) =>
        unescapeXml(getTag(d, "Key")),
      );
      deleted.push(...batch.filter((f) => keys.includes(f.path)));
    }
    return deleted;
  }
}

export class S3LikeFile extends BaseFile<S3Context> {
  #send(method: string, path: string, options: SendOptions = {}) {
    return this.ctx.http.send(method, makeUrl(this.ctx, path), options);
  }

  protected async fetch(opts?: ReadOptions): Promise<Response> {
    const rh = this.range && rangeHeader(this.range);
    return this.#send("GET", this.path, {
      headers: rh ? { Range: rh } : {},
      signal: opts?.signal,
    });
  }

  async info(opts?: ReadOptions): Promise<FileInfo | null> {
    throwIfAborted(opts?.signal);
    const res = await this.#send("HEAD", this.path, {
      signal: opts?.signal,
      ok: [404],
      what: "HEAD",
    });
    if (res.status === 404) return null;
    return {
      size: rangeSize(
        this.range,
        parseInt(res.headers.get("content-length") ?? "0", 10),
      ),
      type: res.headers.get("content-type"),
      modified: new Date(res.headers.get("last-modified") ?? Date.now()),
      version: res.headers.get("x-amz-version-id"),
      metadata: metaFromHeaders(res.headers, "x-amz-meta-"),
    };
  }

  #putHeaders(options: WriteOptions): Record<string, string> {
    return metaHeaders(this.meta(options), {
      type: "Content-Type",
      cacheControl: "Cache-Control",
      disposition: "Content-Disposition",
      metaPrefix: "x-amz-meta-",
    });
  }

  protected async put(data: Buffer, options: WriteOptions): Promise<void> {
    await this.#send("PUT", this.path, {
      body: data,
      headers: this.#putHeaders(options),
      signal: options.signal,
      what: "PUT",
    });
  }

  protected target(options: WriteOptions) {
    return multipartS3({
      provider: this.provider,
      path: this.path,
      makeUrl: (p) => makeUrl(this.ctx, p),
      getAuth: () => this.ctx.auth.get(),
      headers: this.#putHeaders(options),
      single: (data) => this.put(data, options),
      signal: options.signal,
    });
  }

  async copyTo(dest: string | BucketFile, opts?: ReadOptions) {
    throwIfAborted(opts?.signal);
    if (typeof dest !== "string") return dest.write(this, opts);
    const dst = destKey(this.ctx.prefix, dest, this.name);
    await this.#send("PUT", dst, {
      headers: {
        "x-amz-copy-source": `/${this.ctx.config.name}/${this.path}`,
      },
      signal: opts?.signal,
      what: "COPY",
    });
    return this.at(dst);
  }

  async remove(opts?: ReadOptions): Promise<this> {
    throwIfAborted(opts?.signal);
    // Already gone is success: removing a path twice is a no-op
    await this.#send("DELETE", this.path, {
      signal: opts?.signal,
      ok: [404, 204],
      what: "DELETE",
    });
    return this;
  }

  protected async canonicalUrl() {
    return this.ctx.config.canonicalPublic
      ? publicUrlFrom(this.ctx.url, this.path)
      : null;
  }

  async #presign(method: "GET" | "PUT", opts: { expires: number | string }) {
    const auth = await this.ctx.auth.get();
    return presignS3(
      makeUrl(this.ctx, this.path),
      method,
      auth,
      expiresIn(opts),
    );
  }

  signedUrl(opts: { expires: number | string }) {
    return this.#presign("GET", opts);
  }

  uploadUrl(opts: { expires: number | string }) {
    return this.#presign("PUT", opts);
  }
}
