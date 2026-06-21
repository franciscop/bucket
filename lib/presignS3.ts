import { createHash, createHmac } from "node:crypto";
import type { S3Auth } from "./types.ts";

const hash = (str: string): string =>
  createHash("sha256").update(str).digest("hex");

const khash = (key: Buffer | string, str: string) =>
  createHmac("sha256", key).update(str);

const plainDate = (): string =>
  new Date()
    .toISOString()
    .replace(/-/g, "")
    .replace(/:/g, "")
    .replace(/\.\d+/, "");

export function presignS3(
  url: string,
  method: "GET" | "PUT",
  auth: S3Auth,
  expiresSeconds: number,
): string {
  const u = new URL(url);
  const timestamp = plainDate();
  const datestamp = timestamp.slice(0, 8);
  const credential = `${auth.id}/${datestamp}/${auth.region}/s3/aws4_request`;
  const signedHeaders = "host";

  u.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  u.searchParams.set("X-Amz-Credential", credential);
  u.searchParams.set("X-Amz-Date", timestamp);
  u.searchParams.set("X-Amz-Expires", String(expiresSeconds));
  u.searchParams.set("X-Amz-SignedHeaders", signedHeaders);
  if (auth.sessionToken) {
    u.searchParams.set("X-Amz-Security-Token", auth.sessionToken);
  }
  u.searchParams.sort();

  // S3 re-encodes the path it receives, so the signature must cover the
  // percent-encoded form of any RFC-3986 sub-delimiters (! ' ( ) *).
  const canonicalPath = u.pathname.replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  const canonicalRequest = [
    method,
    canonicalPath,
    u.searchParams.toString(),
    `host:${u.host}\n`,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const scope = `${datestamp}/${auth.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    hash(canonicalRequest),
  ].join("\n");

  const kDate = khash(`AWS4${auth.secret}`, datestamp).digest();
  const kRegion = khash(kDate, auth.region).digest();
  const kService = khash(kRegion, "s3").digest();
  const kSigning = khash(kService, "aws4_request").digest();
  const signature = khash(kSigning, stringToSign).digest("hex");

  u.searchParams.set("X-Amz-Signature", signature);
  return u.toString();
}
