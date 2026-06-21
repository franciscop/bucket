import type { S3Auth } from "./types.ts";
import { sha256hex, hmacSha256, toHex } from "./webcrypto.ts";

const plainDate = (): string =>
  new Date()
    .toISOString()
    .replace(/-/g, "")
    .replace(/:/g, "")
    .replace(/\.\d+/, "");

export async function presignS3(
  url: string,
  method: "GET" | "PUT",
  auth: S3Auth,
  expiresSeconds: number,
): Promise<string> {
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
    await sha256hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmacSha256(`AWS4${auth.secret}`, datestamp);
  const kRegion = await hmacSha256(kDate, auth.region);
  const kService = await hmacSha256(kRegion, "s3");
  const kSigning = await hmacSha256(kService, "aws4_request");
  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  u.searchParams.set("X-Amz-Signature", signature);
  return u.toString();
}
