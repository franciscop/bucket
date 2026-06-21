// Oracle test: cross-check our AWS Signature V4 implementation against `aws4`,
// the battle-tested reference signer. No credentials or network needed; both
// sign the same fully-specified request and the resulting signature must match
// byte-for-byte. This is what proves the S3 and R2 request signer is correct
// (they share lib/cleanAndSignS3.ts), which the mocked suites cannot validate.

import aws4 from "aws4";
import { createHash } from "node:crypto";
import cleanAndSignS3 from "./cleanAndSignS3.ts";
import type { S3Request, S3Auth } from "./types.ts";

const DATE = "20150830T123600Z";
const ID = "AKIDEXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

const sha256 = (b: string): string =>
  createHash("sha256").update(b).digest("hex");

const parseAuth = (header: string) => ({
  signature: /Signature=([0-9a-f]+)/.exec(header)![1],
  signedHeaders: /SignedHeaders=([^,]+)/.exec(header)![1],
});

interface Case {
  name: string;
  url: string;
  method?: string;
  body?: string;
  region?: string;
  headers?: Record<string, string>;
  sessionToken?: string;
}

// Sign with our implementation.
function ours(c: Case) {
  const auth: S3Auth = {
    id: ID,
    secret: SECRET,
    region: c.region ?? "us-east-1",
    sessionToken: c.sessionToken,
  };
  const req: S3Request = {
    url: c.url,
    method: (c.method ?? "GET").toLowerCase(),
    headers: { "x-amz-date": DATE, ...(c.headers ?? {}) },
    body: c.body,
  };
  cleanAndSignS3(req, auth);
  return parseAuth(req.headers.Authorization!);
}

// Sign the equivalent request with aws4 (the reference).
function reference(c: Case) {
  const u = new URL(c.url);
  const headers: Record<string, string> = {
    "X-Amz-Date": DATE,
    "X-Amz-Content-Sha256": sha256(c.body ?? ""),
    ...(c.headers ?? {}),
  };
  if (c.sessionToken) headers["X-Amz-Security-Token"] = c.sessionToken;
  const RequestSigner = (aws4 as unknown as { RequestSigner: any })
    .RequestSigner;
  const signer = new RequestSigner(
    {
      host: u.host,
      method: (c.method ?? "GET").toUpperCase(),
      path: u.pathname + u.search,
      body: c.body,
      service: "s3",
      region: c.region ?? "us-east-1",
      doNotModifyHeaders: true,
      headers,
    },
    { accessKeyId: ID, secretAccessKey: SECRET },
  );
  signer.datetime = DATE;
  return parseAuth(signer.authHeader());
}

const B = "https://my-bucket.s3.us-east-1.amazonaws.com";

const cases: Case[] = [
  { name: "simple GET", url: `${B}/hello.txt` },
  { name: "nested key GET", url: `${B}/deep/path/readme.txt` },
  {
    name: "list with sorted query params",
    url: `${B}/?list-type=2&prefix=logs%2F&continuation-token=abc123`,
  },
  {
    name: "PUT with body and content headers",
    url: `${B}/data/file.txt`,
    method: "put",
    body: "hello world",
    headers: { "Content-Type": "text/plain", "Content-Length": "11" },
  },
  { name: "DELETE", url: `${B}/old.txt`, method: "delete" },
  {
    name: "POST DeleteObjects",
    url: `${B}/?delete=`,
    method: "post",
    body: "<Delete><Object><Key>a.txt</Key></Object></Delete>",
    headers: { "content-md5": "" },
  },
  // The case the FS/B2 fixture `a-1*(a!.txt` is designed to surface: RFC-3986
  // sub-delimiters must be percent-encoded in the canonical URI, or S3 → 403.
  { name: "key with sub-delimiters ! * (", url: `${B}/a-1*(a!.txt` },
  { name: "key with apostrophe and parens", url: `${B}/o'brien (1).txt` },
  { name: "key with spaces", url: `${B}/with space.txt` },
  { name: "key with unicode", url: `${B}/café/münchen.txt` },
  {
    name: "non-default region",
    url: "https://b.s3.eu-west-1.amazonaws.com/x.txt",
    region: "eu-west-1",
  },
  // Custom endpoint on a non-default port (MinIO / LocalStack / S3-compatible):
  // the signed Host must include the port to match what is actually sent.
  {
    name: "custom endpoint with port",
    url: "http://127.0.0.1:9000/bucket/key.txt",
  },
  {
    name: "custom endpoint with port + query",
    url: "http://localhost:9000/bucket/?list-type=2",
  },
  {
    name: "temporary credentials (session token)",
    url: `${B}/x.txt`,
    sessionToken: "FQoGZXIvYXdzEEXAMPLEsessionTOKEN==",
  },
];

describe("cleanAndSignS3 vs aws4 (SigV4 oracle)", () => {
  for (const c of cases) {
    it(`matches the reference signature: ${c.name}`, () => {
      const a = ours(c);
      const b = reference(c);
      expect(a.signedHeaders).toBe(b.signedHeaders);
      expect(a.signature).toBe(b.signature);
    });
  }
});
