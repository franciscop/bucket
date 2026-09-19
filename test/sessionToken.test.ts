// Temporary STS credentials are a trio: without the session token the
// signature is rejected. These tests mint a real one from MinIO's STS endpoint
// and use it for both signing paths, since a wrong presigned URL only fails
// when something actually follows it.
//
// Emulator-only: it needs an STS endpoint that issues real temporary
// credentials. aws4 signs the AssumeRole call because that is an `sts` service
// request, which the library's own S3-only signer does not cover.
import aws4 from "aws4";

import S3 from "../src/s3/index.ts";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "";
const BUCKET = process.env.AWS_BUCKET ?? "";
const onEmulators = ENDPOINT.includes("127.0.0.1");

interface Trio {
  id: string;
  secret: string;
  token: string;
}

const tagOf = (xml: string, tag: string) =>
  xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? "";

async function assumeRole(): Promise<Trio> {
  const body = "Action=AssumeRole&Version=2011-06-15&DurationSeconds=900";
  const opts = {
    host: new URL(ENDPOINT).host,
    method: "POST",
    path: "/",
    service: "sts",
    region: process.env.AWS_REGION ?? "us-east-1",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  };
  aws4.sign(opts, {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  });
  const res = await fetch(ENDPOINT + "/", {
    method: "POST",
    headers: opts.headers,
    body,
  });
  const xml = await res.text();
  if (!res.ok) throw new Error(`AssumeRole failed: ${res.status} ${xml}`);
  return {
    id: tagOf(xml, "AccessKeyId"),
    secret: tagOf(xml, "SecretAccessKey"),
    token: tagOf(xml, "SessionToken"),
  };
}

describe.skipIf(!onEmulators)("S3 temporary (STS) credentials", () => {
  let trio: Trio;
  const bucketWith = (sessionToken?: string) =>
    S3(BUCKET, {
      id: trio.id,
      secret: trio.secret,
      url: ENDPOINT,
      sessionToken,
    });

  beforeAll(async () => {
    trio = await assumeRole();
  });

  it("mints a usable trio", () => {
    expect(trio.id).not.toBe("");
    expect(trio.secret).not.toBe("");
    expect(trio.token).not.toBe("");
  });

  it("signs requests with the token, so reads and writes work", async () => {
    const file = bucketWith(trio.token).file(`sts-${Date.now()}.txt`);
    await file.write("temporary credentials");
    expect(await file.text()).toBe("temporary credentials");
    await file.remove();
  });

  it("is rejected without the token, proving the token is what works", async () => {
    const file = bucketWith().file(`sts-none-${Date.now()}.txt`);
    let failed = false;
    try {
      await file.write("should not land");
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  it("presigns a download URL that the provider actually accepts", async () => {
    const file = bucketWith(trio.token).file(`sts-get-${Date.now()}.txt`);
    await file.write("presigned with a token");

    const url = await file.signedUrl({ expires: 3600 });
    expect(new URL(url!).searchParams.get("X-Amz-Security-Token")).toBe(
      trio.token,
    );

    // Plain fetch, no credentials of its own: the URL has to stand alone.
    const res = await fetch(url!);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("presigned with a token");
    await file.remove();
  });

  it("presigns an upload URL that the provider actually accepts", async () => {
    const file = bucketWith(trio.token).file(`sts-put-${Date.now()}.txt`);
    const url = await file.uploadUrl({ expires: 3600 });

    const res = await fetch(url!, { method: "PUT", body: "uploaded" });
    expect(res.status).toBe(200);
    expect(await file.text()).toBe("uploaded");
    await file.remove();
  });
});
