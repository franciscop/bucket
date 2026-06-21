import {
  sha256hex,
  importRsaPkcs8,
  rsaSha256,
  toHex,
  toBase64Url,
} from "./webcrypto.ts";

export interface GCSAuth {
  clientEmail: string;
  privateKey: string; // PEM
}

const enc = new TextEncoder();
const b64urlJson = (o: unknown): string =>
  toBase64Url(enc.encode(JSON.stringify(o)));

const plainDate = (): string =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

// Create a signed JWT and exchange it for an OAuth2 access token
export async function getAccessToken(auth: GCSAuth): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "RS256", typ: "JWT" });
  const payload = b64urlJson({
    iss: auth.clientEmail,
    scope: "https://www.googleapis.com/auth/devstorage.read_write",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  });

  const key = await importRsaPkcs8(auth.privateKey);
  const signature = toBase64Url(await rsaSha256(key, `${header}.${payload}`));
  const jwt = `${header}.${payload}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// Get a short-lived access token from the GCP metadata server (Cloud Run, GKE, etc.)
export async function getMetadataToken(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!res.ok) throw new Error("GCS metadata server error: " + res.status);
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
}

// GCS V4 presigned URL
export async function presignGCS(
  bucket: string,
  objectPath: string,
  auth: GCSAuth,
  method: "GET" | "PUT",
  expiresSeconds: number,
): Promise<string> {
  const timestamp = plainDate();
  const datestamp = timestamp.slice(0, 8);
  const credential = `${auth.clientEmail}/${datestamp}/auto/storage/goog4_request`;
  const signedHeaders = "host";
  const host = "storage.googleapis.com";
  const path = `/${bucket}/${objectPath.replace(/^\//, "")}`;

  const params = new URLSearchParams({
    "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
    "X-Goog-Credential": credential,
    "X-Goog-Date": timestamp,
    "X-Goog-Expires": String(expiresSeconds),
    "X-Goog-SignedHeaders": signedHeaders,
  });
  params.sort();

  const canonicalRequest = [
    method,
    path,
    params.toString(),
    `host:${host}\n`,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "GOOG4-RSA-SHA256",
    timestamp,
    `${datestamp}/auto/storage/goog4_request`,
    await sha256hex(canonicalRequest),
  ].join("\n");

  const key = await importRsaPkcs8(auth.privateKey);
  const signature = toHex(await rsaSha256(key, stringToSign));

  params.set("X-Goog-Signature", signature);
  return `https://${host}${path}?${params}`;
}
