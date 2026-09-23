import {
  basicDate,
  canonicalPath,
  canonicalRequest,
  scopeOf,
  signature,
} from "./sigv4.ts";
import type { S3Auth } from "./types.ts";

export async function presignS3(
  url: string,
  method: "GET" | "PUT",
  auth: S3Auth,
  expiresSeconds: number,
): Promise<string> {
  const u = new URL(url);
  const timestamp = basicDate();
  u.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  u.searchParams.set(
    "X-Amz-Credential",
    `${auth.id}/${scopeOf(timestamp, auth.region)}`,
  );
  u.searchParams.set("X-Amz-Date", timestamp);
  u.searchParams.set("X-Amz-Expires", String(expiresSeconds));
  u.searchParams.set("X-Amz-SignedHeaders", "host");
  if (auth.sessionToken)
    u.searchParams.set("X-Amz-Security-Token", auth.sessionToken);
  u.searchParams.sort();
  u.pathname = canonicalPath(u.pathname);

  const canonical = canonicalRequest(
    method,
    u.pathname,
    u.searchParams.toString(),
    { host: u.host },
    "UNSIGNED-PAYLOAD",
  );
  u.searchParams.set(
    "X-Amz-Signature",
    await signature(auth.secret, timestamp, auth.region, canonical),
  );
  return u.toString();
}
