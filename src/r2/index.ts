import { invalidConfig, origin } from "../lib/config.ts";
import { S3LikeBucket, s3Context, type S3LikeConfig } from "../lib/s3like.ts";

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
): S3LikeBucket {
  if (!name)
    invalidConfig(
      "R2 needs a bucket name, as the first argument or R2_BUCKET.",
    );
  const custom = origin(url);
  if (account && custom && custom !== endpointFor(account))
    invalidConfig(
      `R2 account "${account}" implies the endpoint ${endpointFor(account)}, ` +
        `which does not match url "${custom}". Pass one or the other.`,
    );
  if (!account && !custom)
    invalidConfig(
      "R2 needs an account id (or R2_ACCOUNT_ID) to build its endpoint, " +
        "or a url for a custom endpoint.",
    );
  const config: S3LikeConfig = {
    type: "R2",
    name,
    region,
    endpoint: custom || endpointFor(account),
    publicUrl: origin(publicUrl),
    auth: { id, secret, region, sessionToken },
    canonicalPublic: false,
  };
  const ctx = s3Context(config);
  return new S3LikeBucket(ctx);
}
