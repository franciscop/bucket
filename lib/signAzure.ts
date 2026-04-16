import { createHmac } from "node:crypto";

export interface AzureAuth {
  account: string;
  key: string; // base64-encoded account key
}

const plainDate = (): string =>
  new Date().toUTCString();

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

export function signAzure(
  method: string,
  path: string,
  headers: Record<string, string>,
  auth: AzureAuth,
  params: Record<string, string> = {},
): Record<string, string> {
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

  const signature = createHmac("sha256", Buffer.from(auth.key, "base64"))
    .update(stringToSign)
    .digest("base64");

  return {
    ...allHeaders,
    Authorization: `SharedKey ${auth.account}:${signature}`,
  };
}

export function presignAzure(
  account: string,
  container: string,
  blobPath: string,
  key: string,
  method: "r" | "w",
  expiresSeconds: number,
): string {
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

  const signature = createHmac("sha256", Buffer.from(key, "base64"))
    .update(stringToSign)
    .digest("base64");

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
