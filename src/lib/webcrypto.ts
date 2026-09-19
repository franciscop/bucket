// WebCrypto-based primitives so request signing works in any runtime
// (browsers, Cloudflare Workers, Bun, Node) without `node:crypto`.

const enc = new TextEncoder();

// Uint8Array -> BufferSource. Safe at runtime; works around the strict
// ArrayBufferLike vs ArrayBuffer typing in newer lib.dom typed arrays.
const src = (data: string | Uint8Array): BufferSource =>
  (typeof data === "string" ? enc.encode(data) : data) as BufferSource;

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export const toBase64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const base64ToBytes = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export async function sha256hex(data: string | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", src(data));
  return toHex(new Uint8Array(buf));
}

export async function sha1hex(data: string | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", src(data));
  return toHex(new Uint8Array(buf));
}

export async function hmacSha256(
  key: string | Uint8Array,
  data: string,
): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    src(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, src(data)));
}

// Import a PKCS#8 PEM private key (as used by GCS service accounts) for RSA signing.
export async function importRsaPkcs8(pem: string): Promise<CryptoKey> {
  const der = base64ToBytes(
    pem
      .replace(/-----BEGIN [^-]+-----/, "")
      .replace(/-----END [^-]+-----/, "")
      .replace(/\s+/g, ""),
  );
  return crypto.subtle.importKey(
    "pkcs8",
    src(der),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function rsaSha256(
  key: CryptoKey,
  data: string,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, src(data)),
  );
}

// Base64-encoded SHA-256 digest, for the S3 `x-amz-checksum-sha256` header.
// The multi-object-delete API (POST /?delete) requires a body integrity header
// (Content-MD5 or an x-amz-checksum-*); we use SHA-256 since WebCrypto provides
// it and S3, R2 and MinIO all accept it.
export async function sha256base64(data: string | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", src(data));
  return toBase64(new Uint8Array(buf));
}
