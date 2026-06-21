// Oracle test for presigned S3/R2 URLs: cross-check presignS3 against aws4's
// query-signing mode. Time is frozen with setSystemTime so presignS3's internal
// clock is deterministic and both signers use the same X-Amz-Date.

import aws4 from "aws4";
import {
  setSystemTime,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "bun:test";
import { presignS3 } from "./presignS3.ts";
import type { S3Auth } from "./types.ts";

const DATE_ISO = "2015-08-30T12:36:00.000Z";
const DATE = "20150830T123600Z";
const auth: S3Auth = {
  id: "AKIDEXAMPLE",
  secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
};

const sigOf = (url: string): string | null =>
  new URL(url).searchParams.get("X-Amz-Signature");

function reference(
  host: string,
  path: string,
  method: "GET" | "PUT",
  expires: number,
  region: string,
): string | null {
  const RequestSigner = (aws4 as unknown as { RequestSigner: any })
    .RequestSigner;
  const signer = new RequestSigner(
    {
      host,
      method,
      path: `${path}?X-Amz-Expires=${expires}`,
      service: "s3",
      region,
      signQuery: true,
      headers: {},
    },
    { accessKeyId: auth.id, secretAccessKey: auth.secret },
  );
  signer.datetime = DATE;
  const signed = signer.sign() as { path: string };
  const query = signed.path.slice(signed.path.indexOf("?") + 1);
  return new URLSearchParams(query).get("X-Amz-Signature");
}

describe("presignS3 vs aws4 (presigned URL oracle)", () => {
  beforeAll(() => setSystemTime(new Date(DATE_ISO)));
  afterAll(() => setSystemTime());

  const host = "my-bucket.s3.us-east-1.amazonaws.com";
  const url = (key: string) => `https://${host}/${key}`;

  it("GET (download) URL matches the reference", async () => {
    const ours = await presignS3(url("file.txt"), "GET", auth, 3600);
    expect(sigOf(ours)).toBe(
      reference(host, "/file.txt", "GET", 3600, auth.region),
    );
  });

  it("PUT (upload) URL matches the reference", async () => {
    const ours = await presignS3(url("upload.bin"), "PUT", auth, 900);
    expect(sigOf(ours)).toBe(
      reference(host, "/upload.bin", "PUT", 900, auth.region),
    );
  });

  it("nested key matches the reference", async () => {
    const ours = await presignS3(url("a/b/c.txt"), "GET", auth, 3600);
    expect(sigOf(ours)).toBe(
      reference(host, "/a/b/c.txt", "GET", 3600, auth.region),
    );
  });

  it("special-character key matches the reference", async () => {
    const ours = await presignS3(url("a-1*(a!.txt"), "GET", auth, 3600);
    expect(sigOf(ours)).toBe(
      reference(host, "/a-1*(a!.txt", "GET", 3600, auth.region),
    );
  });

  it("non-default region matches the reference", async () => {
    const h = "b.s3.eu-west-1.amazonaws.com";
    const a: S3Auth = { ...auth, region: "eu-west-1" };
    const ours = await presignS3(`https://${h}/x.txt`, "GET", a, 3600);
    expect(sigOf(ours)).toBe(reference(h, "/x.txt", "GET", 3600, "eu-west-1"));
  });

  it("custom endpoint with port matches the reference", async () => {
    const h = "127.0.0.1:9000";
    const ours = await presignS3(
      `http://${h}/bucket/key.txt`,
      "GET",
      auth,
      3600,
    );
    expect(sigOf(ours)).toBe(
      reference(h, "/bucket/key.txt", "GET", 3600, auth.region),
    );
  });

  it("produces a structurally valid SigV4 query", async () => {
    const u = new URL(await presignS3(url("x.txt"), "GET", auth, 3600));
    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(u.searchParams.get("X-Amz-Credential")).toContain(
      "/s3/aws4_request",
    );
  });
});
