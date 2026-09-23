import BucketError from "../lib/BucketError.ts";
import { invalidConfig, origin } from "../lib/config.ts";
import { S3LikeBucket, s3Context, type S3LikeConfig } from "../lib/s3like.ts";
import type { S3Auth } from "../lib/types.ts";
import { env } from "../lib/env.ts";

const {
  AWS_BUCKET: ENV_BUCKET,
  AWS_ACCESS_KEY_ID: ENV_ID,
  AWS_SECRET_ACCESS_KEY: ENV_KEY,
  AWS_SESSION_TOKEN: ENV_SESSION_TOKEN,
  AWS_REGION: ENV_REGION,
  AWS_ENDPOINT_URL: ENV_ENDPOINT,
  AWS_PUBLIC_URL: ENV_PUBLIC_URL,
} = env;

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

async function fetchInstanceCredentials(region: string) {
  const toCache = (
    data: InstanceCredResponse,
  ): S3Auth & { expiry: number } => ({
    id: data.AccessKeyId,
    secret: data.SecretAccessKey,
    sessionToken: data.Token,
    region,
    expiry: new Date(data.Expiration).getTime(),
  });
  const json = async (res: Response, what: string) => {
    if (!res.ok)
      throw new BucketError(`S3 could not fetch ${what} credentials`, {
        provider: "S3",
        status: res.status,
        code: "UNAUTHORIZED",
      });
    return toCache((await res.json()) as InstanceCredResponse);
  };

  // Lambda / ECS: full URI (newer format)
  const fullUri = env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  if (fullUri) {
    const token = env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    const headers: Record<string, string> = token
      ? { Authorization: token }
      : {};
    return json(await fetch(fullUri, { headers }), "container");
  }
  // Lambda / ECS: relative URI (older format)
  const relUri = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  if (relUri)
    return json(await fetch(`http://169.254.170.2${relUri}`), "container");

  // EC2: IMDSv2, get a session token first, then role creds
  const imds = "http://169.254.169.254/latest";
  let headers: Record<string, string> = {};
  try {
    const r = await fetch(`${imds}/api/token`, {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" },
    });
    if (r.ok) headers = { "X-aws-ec2-metadata-token": await r.text() };
  } catch {}
  const roleRes = await fetch(`${imds}/meta-data/iam/security-credentials/`, {
    headers,
  });
  if (!roleRes.ok)
    throw new BucketError(
      "No IAM role found. Is this an EC2 instance with an instance profile?",
      { provider: "S3", status: roleRes.status, code: "UNAUTHORIZED" },
    );
  const role = (await roleRes.text()).trim().split("\n")[0];
  return json(
    await fetch(`${imds}/meta-data/iam/security-credentials/${role}`, {
      headers,
    }),
    "EC2 instance",
  );
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
export default function S3(
  bucket: string = ENV_BUCKET || "",
  {
    id = ENV_ID || "",
    secret = ENV_KEY || "",
    region = ENV_REGION || "us-east-1",
    url,
    publicUrl = ENV_PUBLIC_URL || "",
    sessionToken = ENV_SESSION_TOKEN,
  }: S3Config = {},
): S3LikeBucket {
  if (!bucket)
    invalidConfig(
      "S3 needs a bucket name, as the first argument or AWS_BUCKET.",
    );
  const config: S3LikeConfig = {
    type: "S3",
    name: bucket,
    region,
    endpoint: origin(url ?? ENV_ENDPOINT),
    publicUrl: origin(publicUrl),
    auth: id && secret ? { id, secret, region, sessionToken } : null,
    resolveAuth: fetchInstanceCredentials,
    canonicalPublic: true,
  };
  const ctx = s3Context(config);
  return new S3LikeBucket(ctx);
}
