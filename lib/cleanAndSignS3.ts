import type { S3Auth, S3Request } from "./types.ts";
import { sha256hex, hmacSha256, toHex } from "./webcrypto.ts";

// AWS canonicalizes the URI by percent-encoding RFC-3986 sub-delimiters that the
// URL parser leaves raw (! ' ( ) *). The request is still SENT with the raw path;
// S3 re-encodes what it receives, so the signature must cover the encoded form.
// (Without this, keys containing those characters get a 403 from S3/R2.)
const encodePath = (pathname: string): string =>
  pathname.replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );

const canonical = async ({
  headers = {},
  ...config
}: S3Request): Promise<string> => {
  const url = new URL(config.url);
  const method = (config.method || "GET").toUpperCase();
  const path = encodePath(url.pathname);
  url.searchParams.sort();
  const query = url.searchParams.toString();
  const headersPlain =
    Object.entries(headers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => k.toLowerCase() + ":" + v.trim())
      .join("\n") + "\n"; // [SIC]
  const headerKeys = Object.keys(headers)
    .sort()
    .map((h) => h.toLowerCase())
    .join(";");
  const payload = await sha256hex((config.body as string | Uint8Array) || "");
  return [method, path, query, headersPlain, headerKeys, payload].join("\n");
};

const getStringToSign = async (
  request: S3Request,
  region: string,
): Promise<string> => {
  const name = "AWS4-HMAC-SHA256";
  const timestamp = request.headers["x-amz-date"];
  const scope = [timestamp.slice(0, 8), region, "s3", "aws4_request"].join("/");
  const canon = await sha256hex(await canonical(request));
  return [name, timestamp, scope, canon].join("\n");
};

const createSignature = async (
  request: S3Request,
  key: string,
  region: string,
): Promise<string> => {
  if (!key) throw new Error("Key is required");
  const stringToSign = await getStringToSign(request, region);
  const dateStamp = request.headers["x-amz-date"].slice(0, 8);
  const kDate = await hmacSha256(`AWS4${key}`, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, "s3");
  const kSigning = await hmacSha256(kService, "aws4_request");
  return toHex(await hmacSha256(kSigning, stringToSign));
};

const createAuth = async (
  auth: S3Auth,
  request: S3Request,
): Promise<string> => {
  if (!auth.id) throw new Error("ID is required");
  if (!auth.secret) throw new Error("Secret is required");
  const signature = await createSignature(request, auth.secret, auth.region);
  const date = request.headers["x-amz-date"].slice(0, 8);
  const credential = `${auth.id}/${date}/${auth.region}/s3/aws4_request`;
  const headers = Object.keys(request.headers)
    .sort()
    .map((h) => h.toLowerCase())
    .join(";");
  // Note: intentionally matches original format (no space after AWS4-HMAC-SHA256)
  return `AWS4-HMAC-SHA256 Credential=${credential},SignedHeaders=${headers},Signature=${signature}`;
};

const sortValue = (
  obj: Record<string, string | undefined> = {},
): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(obj)
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([, v]) => typeof v !== "undefined"),
  ) as Record<string, string>;
};

const plainDate = (): string =>
  new Date()
    .toISOString()
    .replace(/-/g, "")
    .replace(/:/g, "")
    .replace(/\.\d+/, "");

// Adds necessary headers and config, and signs the request
// by adding the `Authorization` header
export default async function cleanAndSignS3(
  request: S3Request,
  auth: S3Auth,
): Promise<S3Request> {
  if (!request.method) request.method = "get";
  if (!request.headers) request.headers = {};
  if (request.method === "get" || request.method === "head") {
    delete (request as Record<string, unknown>).body;
  }

  // We don't want this that is added by Axios
  delete (request.headers as Record<string, unknown>).Accept;

  // .host (not .hostname) so a non-default port is included — required for
  // MinIO / LocalStack / S3-compatible endpoints, and a no-op for AWS (port 443).
  request.headers.host = new URL(request.url).host;
  request.headers["x-amz-content-sha256"] = await sha256hex(
    (request.body as string | Uint8Array) || "",
  );
  request.headers["x-amz-date"] = request.headers["x-amz-date"] || plainDate();
  if (auth.sessionToken) {
    request.headers["x-amz-security-token"] = auth.sessionToken;
  }

  // Sort both query params and headers in alphabetic order
  request.params = sortValue(
    (request.params || {}) as Record<string, string | undefined>,
  );
  request.headers = sortValue(request.headers);

  request.headers.Authorization = await createAuth(auth, request);

  return request;
}
