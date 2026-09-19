import cleanAndSignS3 from "../lib/cleanAndSignS3.ts";
import encodeS3Path from "../lib/encodeS3Path.ts";
import { escapeXml, unescapeXml, extractTags, getTag } from "../lib/xml.ts";
import { sha256base64 } from "../lib/webcrypto.ts";
import BucketError from "../lib/BucketError.ts";
import { fileKey, scope, folderKey } from "../lib/prefix.ts";
import { randomName } from "../lib/nanoid.ts";
import { assertFilter, requireFilter } from "../lib/filter.ts";
import { throwIfAborted, withAbort, type ReadOptions } from "../lib/abort.ts";
import type {
  Bucket,
  BucketInfo,
  S3Auth,
  S3Request,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
import { S3File, type S3BucketContext } from "./File.ts";

const {
  AWS_BUCKET: ENV_BUCKET,
  AWS_ACCESS_KEY_ID: ENV_ID,
  AWS_SECRET_ACCESS_KEY: ENV_KEY,
  AWS_SESSION_TOKEN: ENV_SESSION_TOKEN,
  AWS_REGION: ENV_REGION,
  AWS_ENDPOINT_URL: ENV_ENDPOINT,
  AWS_PUBLIC_URL: ENV_PUBLIC_URL,
} = process.env;

export interface S3Config {
  id?: string;
  secret?: string;
  region?: string;
  sessionToken?: string;
  /** Endpoint *without* the bucket, e.g. `http://127.0.0.1:9000` for MinIO
   * (falls back to `AWS_ENDPOINT_URL`). The bucket name is appended as a path
   * segment. Unset, the virtual-hosted AWS endpoint is used instead. */
  url?: string;
  /** Public origin the bucket is served from, e.g. a CloudFront domain (falls
   * back to `AWS_PUBLIC_URL`). Used by `file.publicUrl()`. */
  publicUrl?: string;
}

// ── Instance metadata (EC2 / ECS / Lambda) ────────────────────────────────────

interface InstanceCredResponse {
  AccessKeyId: string;
  SecretAccessKey: string;
  Token: string;
  Expiration: string;
}

interface CachedAuth extends S3Auth {
  expiry: number;
}

async function fetchInstanceCredentials(region: string): Promise<CachedAuth> {
  // Lambda / ECS: full URI (newer format)
  const fullUri = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  if (fullUri) {
    const headers: Record<string, string> = {};
    const token = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    if (token) headers["Authorization"] = token;
    const res = await fetch(fullUri, { headers });
    if (!res.ok) throw new Error("Failed to fetch container credentials");
    return toCache(region, (await res.json()) as InstanceCredResponse);
  }

  // Lambda / ECS: relative URI (older format)
  const relUri = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  if (relUri) {
    const res = await fetch(`http://169.254.170.2${relUri}`);
    if (!res.ok) throw new Error("Failed to fetch container credentials");
    return toCache(region, (await res.json()) as InstanceCredResponse);
  }

  // EC2: IMDSv2, get a session token first, then role creds
  let imdsToken = "";
  try {
    const r = await fetch("http://169.254.169.254/latest/api/token", {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" },
    });
    if (r.ok) imdsToken = await r.text();
  } catch {}

  const metaHeaders: Record<string, string> = imdsToken
    ? { "X-aws-ec2-metadata-token": imdsToken }
    : {};

  const roleRes = await fetch(
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    { headers: metaHeaders },
  );
  if (!roleRes.ok)
    throw new Error(
      "No IAM role found. Is this an EC2 instance with an instance profile?",
    );
  const roleName = (await roleRes.text()).trim().split("\n")[0];

  const credRes = await fetch(
    `http://169.254.169.254/latest/meta-data/iam/security-credentials/${roleName}`,
    { headers: metaHeaders },
  );
  if (!credRes.ok) throw new Error("Failed to fetch EC2 instance credentials");
  return toCache(region, (await credRes.json()) as InstanceCredResponse);
}

function toCache(region: string, data: InstanceCredResponse): CachedAuth {
  return {
    id: data.AccessKeyId,
    secret: data.SecretAccessKey,
    sessionToken: data.Token,
    region,
    expiry: new Date(data.Expiration).getTime(),
  };
}

// ── XML helpers ───────────────────────────────────────────────────────────────

// ── S3Bucket ──────────────────────────────────────────────────────────────────

class S3Bucket implements Bucket {
  readonly type = "S3";
  private bucketName: string;
  private region: string;
  private url: string;
  // The configured endpoint, kept apart from `url` (which has the bucket
  // appended) so folder() can rebuild without appending it twice.
  #endpoint: string;
  #publicUrl: string;
  #auth: S3Auth | null;
  #cachedAuth: CachedAuth | null = null;
  PREFIX = "";

  constructor(
    bucketName: string = ENV_BUCKET || "",
    {
      id = ENV_ID || "",
      secret = ENV_KEY || "",
      region = ENV_REGION || "us-east-1",
      url,
      publicUrl = ENV_PUBLIC_URL || "",
      sessionToken = ENV_SESSION_TOKEN,
    }: S3Config = {},
  ) {
    if (!bucketName) {
      throw new BucketError(
        "S3 needs a bucket name, as the first argument or AWS_BUCKET.",
        { code: "INVALID_CONFIG" },
      );
    }
    this.bucketName = bucketName;
    this.region = region;
    this.#endpoint = (url ?? ENV_ENDPOINT ?? "").replace(/\/+$/, "");
    this.#publicUrl = publicUrl.replace(/\/+$/, "");
    // A custom endpoint is path-style (MinIO, Spaces, Ceph): append the bucket.
    // Without one, AWS's virtual-hosted endpoint puts it in the subdomain.
    this.url = this.#endpoint
      ? `${this.#endpoint}/${bucketName}`
      : `https://${bucketName}.s3.${region}.amazonaws.com`;
    this.#auth = id && secret ? { id, secret, region, sessionToken } : null;
  }

  async #getAuth(): Promise<S3Auth> {
    if (this.#auth) return this.#auth;
    if (this.#cachedAuth && Date.now() < this.#cachedAuth.expiry - 60_000) {
      return this.#cachedAuth;
    }
    this.#cachedAuth = await fetchInstanceCredentials(this.region);
    return this.#cachedAuth;
  }

  private makeUrl(path: string = ""): string {
    const cleanPath = path ? (path.startsWith("/") ? path : "/" + path) : "";
    // Encode the key so the sent path matches what the signer canonicalizes.
    return this.url + encodeS3Path(cleanPath);
  }

  private async doRequest(
    method: string,
    path: string,
    options: {
      body?: string | Buffer;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    const url = this.makeUrl(path);
    const auth = await this.#getAuth();
    const req: S3Request = {
      url,
      method: method.toLowerCase(),
      headers: { ...(options.headers || {}) },
      body: options.body,
    };
    await cleanAndSignS3(req, auth);
    // The one place every request funnels through, so an abort becomes a
    // BucketError here rather than in each caller.
    return withAbort(options.signal, () =>
      fetch(url, {
        method: method.toUpperCase(),
        headers: req.headers,
        body: options.body as BodyInit | undefined,
        signal: options.signal,
      }),
    );
  }

  async info(opts?: ReadOptions): Promise<BucketInfo> {
    throwIfAborted(opts?.signal);
    const auth = await this.#getAuth();
    return {
      type: this.type,
      name: this.bucketName,
      url: this.url,
      id: auth.id,
    };
  }

  async *#pages(filter?: RegExp, opts?: ReadOptions): AsyncGenerator<S3File[]> {
    let token: string | undefined;
    const s = scope(this.PREFIX, filter);

    do {
      throwIfAborted(opts?.signal);
      const url = new URL(this.makeUrl(""));
      url.searchParams.set("list-type", "2");
      if (s.query) url.searchParams.set("prefix", s.query);
      if (token) url.searchParams.set("continuation-token", token);

      const auth = await this.#getAuth();
      const req: S3Request = {
        url: url.toString(),
        method: "get",
        headers: {},
      };
      await cleanAndSignS3(req, auth);

      const res = await fetch(url.toString(), {
        method: "GET",
        headers: req.headers,
        signal: opts?.signal,
      });
      if (!res.ok)
        throw new BucketError(`S3 list error: ${res.status}`, {
          provider: "S3",
          status: res.status,
        });

      const xmlStr = await res.text();
      const page: S3File[] = [];
      for (const item of extractTags(xmlStr, "Contents")) {
        const key = unescapeXml(getTag(item, "Key"));
        if (!s.test(key)) continue;
        page.push(this.#handle(key));
      }
      yield page;

      token =
        getTag(xmlStr, "IsTruncated") === "true"
          ? getTag(xmlStr, "NextContinuationToken")
          : undefined;
    } while (token);
  }

  scan(filter?: RegExp, opts?: ReadOptions): AsyncGenerator<S3File> {
    assertFilter(filter);
    // Eager, like the filter check: an aborted scan must not wait for the
    // first iteration to reject.
    throwIfAborted(opts?.signal);
    return this.#scan(filter, opts);
  }

  async *#scan(filter?: RegExp, opts?: ReadOptions): AsyncGenerator<S3File> {
    for await (const page of this.#pages(filter, opts)) {
      for (const file of page) {
        throwIfAborted(opts?.signal);
        yield file;
      }
    }
  }

  async list(filter?: RegExp, opts?: ReadOptions): Promise<S3File[]> {
    assertFilter(filter);
    throwIfAborted(opts?.signal);
    const files: S3File[] = [];
    for await (const page of this.#pages(filter, opts)) files.push(...page);
    return files;
  }

  async remove(filter: RegExp, opts?: ReadOptions): Promise<S3File[]> {
    requireFilter(filter);
    throwIfAborted(opts?.signal);
    const files = await this.list(filter, opts);
    if (!files.length) return [];

    const deleted: S3File[] = [];
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
      const auth = await this.#getAuth();
      // DeleteObjects requires a body integrity header; S3/R2/MinIO 400 without it.
      const req: S3Request = {
        url: url.toString(),
        method: "post",
        headers: { "x-amz-checksum-sha256": await sha256base64(body) },
        body,
      };
      await cleanAndSignS3(req, auth);

      const res = await fetch(url.toString(), {
        method: "POST",
        headers: req.headers,
        body,
        signal: opts?.signal,
      });
      if (!res.ok)
        throw new BucketError(
          `S3 delete error: ${res.status} ${await res.text()}`,
          { provider: "S3", status: res.status },
        );

      const xmlStr = await res.text();
      const keys = extractTags(xmlStr, "Deleted").map((d) =>
        unescapeXml(getTag(d, "Key")),
      );
      deleted.push(...batch.filter((f) => keys.includes(f.path)));
    }

    return deleted;
  }

  #handle(path: string): S3File {
    const ctx: S3BucketContext = {
      makeUrl: (p) => this.makeUrl(p),
      doRequest: (m, p, opts) => this.doRequest(m, p, opts),
      getAuth: () => this.#getAuth(),
      bucketName: this.bucketName,
      url: this.url,
      publicUrl: this.#publicUrl,
      prefix: this.PREFIX,
    };
    return new S3File(path, ctx);
  }

  file(name: string): S3File {
    if (!name) throw new Error("No name");
    return this.#handle(fileKey(this.PREFIX, name));
  }

  async create(content: WriteContent, options?: WriteOptions): Promise<S3File> {
    throwIfAborted(options?.signal);
    throwIfAborted(options?.signal);
    return this.file(randomName(content, options)).write(content, options);
  }

  folder(path: string): S3Bucket {
    const b = new S3Bucket(this.bucketName, {
      region: this.region,
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

  async *[Symbol.asyncIterator](): AsyncGenerator<S3File> {
    yield* this.scan();
  }
}

/**
 * Create an AWS S3 bucket handle.
 *
 * @param bucket - Bucket name (falls back to `AWS_BUCKET` env var)
 * @param config.id - Access Key ID (falls back to `AWS_ACCESS_KEY_ID`)
 * @param config.secret - Secret Access Key (falls back to `AWS_SECRET_ACCESS_KEY`)
 * @param config.sessionToken - Session token for temporary credentials (falls back to `AWS_SESSION_TOKEN`)
 * @param config.region - AWS region, default `"us-east-1"` (falls back to `AWS_REGION`)
 * @param config.url - Endpoint without the bucket, which gets appended (falls back to `AWS_ENDPOINT_URL`)
 * @param config.publicUrl - Public origin for `file.publicUrl()` (falls back to `AWS_PUBLIC_URL`)
 *
 * When `id` and `secret` are not provided, credentials are resolved automatically
 * from the environment: ECS/Lambda container credentials or EC2 instance metadata.
 *
 * @example
 * const bucket = S3("my-bucket", { id: "keyId", secret: "secretKey", region: "us-west-2" });
 * await bucket.file("hello.txt").write("hello");
 */
export default function S3(bucket?: string, config?: S3Config): S3Bucket {
  return new S3Bucket(bucket, config);
}

export type {
  Bucket,
  BucketFile,
  FileInfo,
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
