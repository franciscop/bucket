import cleanAndSignS3 from "../lib/cleanAndSignS3.ts";
import { sha256base64 } from "../lib/webcrypto.ts";
import type { IBucket, BucketInfo, S3Auth, S3Request } from "../lib/types.ts";
import { S3File, type S3BucketContext } from "./File.ts";

const {
  AWS_BUCKET: ENV_BUCKET,
  AWS_ACCESS_KEY_ID: ENV_ID,
  AWS_SECRET_ACCESS_KEY: ENV_KEY,
  AWS_SESSION_TOKEN: ENV_SESSION_TOKEN,
  AWS_REGION: ENV_REGION,
  AWS_ENDPOINT: ENV_ENDPOINT,
} = process.env;

export interface S3Config {
  id?: string;
  secret?: string;
  region?: string;
  endpoint?: string;
  sessionToken?: string;
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

function extractTags(xmlStr: string, tag: string): string[] {
  const results: string[] = [];
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xmlStr)) !== null) results.push(match[1]);
  return results;
}

function getTag(xmlStr: string, tag: string): string {
  return extractTags(xmlStr, tag)[0] ?? "";
}

// ── S3Bucket ──────────────────────────────────────────────────────────────────

class S3Bucket implements IBucket {
  readonly type = "S3";
  private bucketName: string;
  private region: string;
  private endpoint: string;
  #staticAuth: S3Auth | null;
  #cachedAuth: CachedAuth | null = null;

  constructor(
    bucketName: string = ENV_BUCKET || "",
    {
      id = ENV_ID || "",
      secret = ENV_KEY || "",
      region = ENV_REGION || "us-east-1",
      endpoint,
      sessionToken = ENV_SESSION_TOKEN,
    }: S3Config = {},
  ) {
    this.bucketName = bucketName;
    this.region = region;
    this.endpoint =
      endpoint ||
      ENV_ENDPOINT ||
      `https://${bucketName}.s3.${region}.amazonaws.com`;
    this.#staticAuth =
      id && secret ? { id, secret, region, sessionToken } : null;
  }

  async #getAuth(): Promise<S3Auth> {
    if (this.#staticAuth) return this.#staticAuth;
    if (this.#cachedAuth && Date.now() < this.#cachedAuth.expiry - 60_000) {
      return this.#cachedAuth;
    }
    this.#cachedAuth = await fetchInstanceCredentials(this.region);
    return this.#cachedAuth;
  }

  private makeUrl(path: string = ""): string {
    const cleanPath = path ? (path.startsWith("/") ? path : "/" + path) : "";
    return this.endpoint + cleanPath;
  }

  private async doRequest(
    method: string,
    path: string,
    options: { body?: string | Buffer; headers?: Record<string, string> } = {},
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
    return fetch(url, {
      method: method.toUpperCase(),
      headers: req.headers,
      body: options.body as BodyInit | undefined,
    });
  }

  async info(): Promise<BucketInfo> {
    const auth = await this.#getAuth();
    return {
      type: this.type,
      name: this.bucketName,
      endpoint: this.endpoint,
      id: auth.id,
    };
  }

  async list(filter?: string | RegExp): Promise<S3File[]> {
    const files: S3File[] = [];
    let token: string | undefined;

    do {
      const url = new URL(this.makeUrl(""));
      url.searchParams.set("list-type", "2");
      if (filter && typeof filter === "string")
        url.searchParams.set("prefix", filter);
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
      });
      if (!res.ok) throw new Error(`S3 list error: ${res.status}`);

      const xmlStr = await res.text();
      for (const item of extractTags(xmlStr, "Contents")) {
        const key = getTag(item, "Key");
        if (filter instanceof RegExp && !filter.test(key)) continue;
        files.push(this.file(key));
      }

      token =
        getTag(xmlStr, "IsTruncated") === "true"
          ? getTag(xmlStr, "NextContinuationToken")
          : undefined;
    } while (token);

    return files;
  }

  async remove(filter?: string | RegExp): Promise<S3File[]> {
    const files = await this.list(filter);
    if (!files.length) return [];

    const deleted: S3File[] = [];
    for (let i = 0; i < files.length; i += 1000) {
      const batch = files.slice(i, i + 1000);
      const body =
        `<Delete>` +
        batch.map((f) => `<Object><Key>${f.path}</Key></Object>`).join("") +
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
      });
      if (!res.ok)
        throw new Error(`S3 delete error: ${res.status} ${await res.text()}`);

      const xmlStr = await res.text();
      const keys = extractTags(xmlStr, "Deleted").map((d) => getTag(d, "Key"));
      deleted.push(...batch.filter((f) => keys.includes(f.path)));
    }

    return deleted;
  }

  file(name: string): S3File {
    if (!name) throw new Error("No name");
    const ctx: S3BucketContext = {
      makeUrl: (p) => this.makeUrl(p),
      doRequest: (m, p, opts) => this.doRequest(m, p, opts),
      getAuth: () => this.#getAuth(),
      bucketName: this.bucketName,
      endpoint: this.endpoint,
    };
    return new S3File(name, ctx);
  }

  async count(filter?: string | RegExp): Promise<number> {
    return (await this.list(filter)).length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<S3File> {
    for (const file of await this.list()) yield file;
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
 * @param config.endpoint - Custom endpoint URL (falls back to `AWS_ENDPOINT`)
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

export { S3Bucket, S3File };

export type {
  FileInfo,
  BucketInfo,
  FileEntry,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
