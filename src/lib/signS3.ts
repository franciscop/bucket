import BucketError from "./BucketError.ts";
import encodeS3Path from "./encodeS3Path.ts";
import { sha256hex } from "./webcrypto.ts";
import {
  basicDate,
  canonicalRequest,
  signature,
  signedHeaders,
} from "./sigv4.ts";
import type { HttpRequest } from "./http.ts";
import type { S3Auth } from "./types.ts";

/** Returns the request with the SigV4 `Authorization` and the headers it
 * covers (host, payload hash, date, session token) filled in. */
export default async function signS3(
  req: HttpRequest,
  auth: S3Auth,
): Promise<HttpRequest> {
  if (!auth.id || !auth.secret)
    throw new BucketError("S3 signing needs an access key id and secret", {
      code: "INVALID_CONFIG",
    });
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : req.body;
  const payload = await sha256hex(body ?? "");
  const headers: Record<string, string> = {
    ...req.headers,
    // .host (not .hostname) so a non-default port is signed, as MinIO and
    // other S3-compatible endpoints require.
    host: url.host,
    "x-amz-content-sha256": payload,
    "x-amz-date": req.headers["x-amz-date"] || basicDate(),
    ...(auth.sessionToken ? { "x-amz-security-token": auth.sessionToken } : {}),
  };
  const timestamp = headers["x-amz-date"];
  url.searchParams.sort();
  const canonical = canonicalRequest(
    method,
    encodeS3Path(url.pathname),
    url.searchParams.toString(),
    headers,
    payload,
  );
  const sig = await signature(auth.secret, timestamp, auth.region, canonical);
  const credential = `${auth.id}/${timestamp.slice(0, 8)}/${auth.region}/s3/aws4_request`;
  return {
    ...req,
    method,
    body,
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${credential},SignedHeaders=${signedHeaders(headers)},Signature=${sig}`,
    },
  };
}
