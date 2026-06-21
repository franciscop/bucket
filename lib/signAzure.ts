import { hmacSha256, base64ToBytes, toBase64 } from "./webcrypto.ts";

export interface AzureAuth {
  account: string;
  key: string; // base64-encoded account key
}

const plainDate = (): string => new Date().toUTCString();

// The canonicalized resource must mirror the request's actual URL path. Real
// Azure keeps the account in the host, so the path is `/container/blob` and the
// prefix is empty. Emulators (Azurite) and path-style endpoints keep the account
// in the URL path, so it must be repeated in the signature — derive that prefix
// from the endpoint, e.g. "http://127.0.0.1:10000/devstoreaccount1" → "/devstoreaccount1".
export const accountPathPrefix = (endpoint: string): string =>
  new URL(endpoint).pathname.replace(/\/$/, "");

function canonicalHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .filter(([k]) => k.toLowerCase().startsWith("x-ms-"))
    .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(([k, v]) => `${k.toLowerCase()}:${v.trim()}`)
    .join("\n");
}

function canonicalResource(
  account: string,
  path: string,
  params: Record<string, string> = {},
): string {
  const base = `/${account}${path.startsWith("/") ? path : "/" + path}`;
  const sorted = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `\n${k}:${v}`)
    .join("");
  return base + sorted;
}

export async function signAzure(
  method: string,
  path: string,
  headers: Record<string, string>,
  auth: AzureAuth,
  params: Record<string, string> = {},
): Promise<Record<string, string>> {
  const date = plainDate();
  const allHeaders: Record<string, string> = {
    ...headers,
    "x-ms-date": date,
    "x-ms-version": "2020-10-02",
  };

  const contentLength = allHeaders["Content-Length"] ?? "";
  const contentType = allHeaders["Content-Type"] ?? "";

  const stringToSign = [
    method.toUpperCase(),
    "", // Content-Encoding
    "", // Content-Language
    contentLength === "0" ? "" : contentLength,
    "", // Content-MD5
    contentType,
    "", // Date (use x-ms-date instead)
    "", // If-Modified-Since
    "", // If-Match
    "", // If-None-Match
    "", // If-Unmodified-Since
    "", // Range
    canonicalHeaders(allHeaders),
    canonicalResource(auth.account, path, params),
  ].join("\n");

  const signature = toBase64(
    await hmacSha256(base64ToBytes(auth.key), stringToSign),
  );

  return {
    ...allHeaders,
    Authorization: `SharedKey ${auth.account}:${signature}`,
  };
}

export async function presignAzure(
  account: string,
  container: string,
  blobPath: string,
  key: string,
  method: "r" | "w",
  expiresSeconds: number,
): Promise<string> {
  const now = new Date();
  const expiry = new Date(now.getTime() + expiresSeconds * 1000);
  const format = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z");
  const start = format(now);
  const end = format(expiry);

  const permissions = method === "w" ? "w" : "r";
  const canonicalizedResource = `/blob/${account}/${container}/${blobPath.replace(/^\//, "")}`;

  const stringToSign = [
    permissions,
    start,
    end,
    canonicalizedResource,
    "", // identifier
    "", // ip
    "https",
    "2020-10-02",
    "b", // signedResource: blob
    "", // snapshot
    "", // encryptionScope
    "", // rscc
    "", // rscd
    "", // rsce
    "", // rscl
    "", // rsct
  ].join("\n");

  const signature = toBase64(
    await hmacSha256(base64ToBytes(key), stringToSign),
  );

  const params = new URLSearchParams({
    sv: "2020-10-02",
    st: start,
    se: end,
    sr: "b",
    sp: permissions,
    spr: "https",
    sig: signature,
  });

  return `https://${account}.blob.core.windows.net/${container}/${blobPath.replace(/^\//, "")}?${params}`;
}
