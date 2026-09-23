// AWS Signature V4, shared by the header-signed request (signS3), the
// query-signed URL (presignS3) and GCS's V4 variant, which differs only in
// the algorithm name and the key.
import { rfc3986 } from "./encodeKey.ts";
import { hmacSha256, sha256hex, toHex } from "./webcrypto.ts";

/** Now as `YYYYMMDDTHHMMSSZ`, the timestamp every V4 signature carries. */
export const basicDate = (): string =>
  new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Lowercased header names, sorted the way V4 wants them listed. */
export const signedHeaders = (headers: Record<string, string>): string =>
  Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort(ordinal)
    .join(";");

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** A URL path as V4 signs it: each segment decoded, then RFC 3986 encoded. */
export const canonicalPath = (pathname: string): string =>
  pathname
    .split("/")
    .map((s) => rfc3986(decode(s)))
    .join("/");

// URLSearchParams would send spaces as "+" and leave !'()* bare, which V4
// servers reject.
/** The query string V4 signs: each pair encoded, then sorted. */
export const canonicalQuery = (params: URLSearchParams): string =>
  [...params]
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .sort(ordinal)
    .join("&");

export function canonicalRequest(
  method: string,
  path: string,
  query: string,
  headers: Record<string, string>,
  payloadHash: string,
): string {
  const sorted = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim()] as [string, string])
    .sort(([a], [b]) => ordinal(a, b));
  return [
    method.toUpperCase(),
    path,
    query,
    sorted.map(([k, v]) => `${k}:${v}`).join("\n") + "\n",
    sorted.map(([k]) => k).join(";"),
    payloadHash,
  ].join("\n");
}

export const scopeOf = (timestamp: string, region: string): string =>
  `${timestamp.slice(0, 8)}/${region}/s3/aws4_request`;

/** The hex HMAC signature of a canonical request. */
export async function signature(
  secret: string,
  timestamp: string,
  region: string,
  canonical: string,
): Promise<string> {
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scopeOf(timestamp, region),
    await sha256hex(canonical),
  ].join("\n");
  let key: string | Uint8Array = `AWS4${secret}`;
  for (const part of [timestamp.slice(0, 8), region, "s3", "aws4_request"])
    key = await hmacSha256(key, part);
  return toHex(await hmacSha256(key, stringToSign));
}
