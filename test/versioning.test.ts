// remove() removes the path, never the history. On a versioned bucket that
// means a delete marker (S3) or a noncurrent generation (GCS): the path stops
// resolving, the earlier versions stay in storage, and the version before the
// one removed must NOT become readable again.
//
// Runs under the emulator harness, which runs it last: it turns versioning on
// for the shared buckets and never turns it back off. Only the emulators that
// really implement versioning are covered:
//   MinIO            versioning + ListObjectVersions ....... covered below
//   fake-gcs-server  generations + ?versions=true .......... covered below
//   Azurite          no versioning (PUT returns no x-ms-version-id)
//   B2               no emulator exists; the hide path is covered by the
//                    request-level tests in b2/index.test.ts
import cleanAndSignS3 from "../lib/cleanAndSignS3.ts";
import type { S3Auth, S3Request } from "../lib/types.ts";
import S3 from "../s3/index.ts";
import GCS from "../gcs/index.ts";

const S3_URL = `${process.env.AWS_ENDPOINT_URL ?? ""}/${process.env.AWS_BUCKET ?? ""}`;
const GCS_URL = process.env.GCS_URL ?? "";
const GCS_BUCKET = process.env.GCS_BUCKET ?? "";

// Both are emulator-only: real S3/GCS buckets would keep the versions (and the
// bill) around long after the run.
const onS3 = (process.env.AWS_ENDPOINT_URL ?? "").includes("127.0.0.1");
const onGCS = GCS_URL.includes("127.0.0.1");

const auth: S3Auth = {
  id: process.env.AWS_ACCESS_KEY_ID ?? "",
  secret: process.env.AWS_SECRET_ACCESS_KEY ?? "",
  region: process.env.AWS_REGION ?? "us-east-1",
};

// Raw provider calls, signed by hand: the version history has to be read
// outside the library, or the test would only prove Bucket agrees with itself.
async function rawS3(method: string, query: string, body?: string) {
  const url = S3_URL + query;
  const req = (await cleanAndSignS3(
    { url, method: method.toLowerCase(), headers: {}, body },
    auth,
  )) as S3Request & { headers: Record<string, string> };
  const res = await fetch(url, { method, headers: req.headers, body });
  return res.text();
}

const name = () => `versioned-${Math.random().toString(36).slice(2, 10)}.txt`;

const codeOf = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
};

describe.skipIf(!onS3)("S3 remove() on a versioned bucket", () => {
  // Built in beforeAll, not here: skipIf still evaluates the describe body, and
  // constructing a bucket with no config throws INVALID_CONFIG.
  let bucket: ReturnType<typeof S3>;

  beforeAll(async () => {
    bucket = S3();
    await rawS3(
      "PUT",
      "?versioning",
      '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>',
    );
  });

  it("hides the path without uncovering the previous version", async () => {
    const file = bucket.file(name());
    await file.write("v1");
    await file.write("v2");
    expect(await file.text()).toBe("v2");

    await file.remove();
    expect(await file.exists()).toBe(false);
    expect(await file.info()).toBeNull();
    expect(await codeOf(() => file.text())).toBe("NOT_FOUND"); // not "v1"
  });

  it("keeps the prior versions in the provider's own listing", async () => {
    const key = name();
    const file = bucket.file(key);
    await file.write("v1");
    await file.write("v2");
    await file.remove();

    const xml = await rawS3("GET", `?versions&prefix=${key}`);
    expect((xml.match(/<Version>/g) ?? []).length).toBe(2);
    expect((xml.match(/<DeleteMarker>/g) ?? []).length).toBe(1);
  });

  it("stays absent from list(), scan() and count()", async () => {
    const key = name();
    await bucket.file(key).write("v1");
    await bucket.file(key).remove();

    const filter = new RegExp(key);
    expect(await bucket.count(filter)).toBe(0);
    expect(await bucket.list(filter)).toEqual([]);
    for await (const found of bucket.scan(filter)) {
      throw new Error(`scan() still yields ${found.path}`);
    }
  });

  it("moveTo() leaves the source's versions behind, like remove()", async () => {
    const src = name();
    const dst = name();
    await bucket.file(src).write("v1");
    await bucket.file(src).write("v2");
    await bucket.file(src).moveTo(dst);

    expect(await bucket.file(dst).text()).toBe("v2");
    expect(await bucket.file(src).exists()).toBe(false);
    expect(await codeOf(() => bucket.file(src).text())).toBe("NOT_FOUND");

    const xml = await rawS3("GET", `?versions&prefix=${src}`);
    expect((xml.match(/<Version>/g) ?? []).length).toBe(2);
    expect((xml.match(/<DeleteMarker>/g) ?? []).length).toBe(1);
  });
});

describe.skipIf(!onGCS)("GCS remove() on a versioned bucket", () => {
  const api = `${GCS_URL}/storage/v1/b/${GCS_BUCKET}`;
  let bucket: ReturnType<typeof GCS>;

  beforeAll(async () => {
    bucket = GCS();
    await fetch(api, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ versioning: { enabled: true } }),
    });
  });

  it("hides the path without uncovering the previous generation", async () => {
    const file = bucket.file(name());
    await file.write("v1");
    await file.write("v2");
    expect(await file.text()).toBe("v2");

    await file.remove();
    expect(await file.exists()).toBe(false);
    expect(await file.info()).toBeNull();
    expect(await codeOf(() => file.text())).toBe("NOT_FOUND"); // not "v1"
  });

  it("keeps the prior generations in the provider's own listing", async () => {
    const key = name();
    const file = bucket.file(key);
    await file.write("v1");
    await file.write("v2");
    await file.remove();

    const res = await fetch(`${api}/o?versions=true`);
    const all = (await res.json()) as { items?: { name: string }[] };
    const mine = (all.items ?? []).filter((item) => item.name === key);
    expect(mine.length).toBe(2);
  });

  it("stays absent from list(), scan() and count()", async () => {
    const key = name();
    await bucket.file(key).write("v1");
    await bucket.file(key).remove();

    const filter = new RegExp(key);
    expect(await bucket.count(filter)).toBe(0);
    expect(await bucket.list(filter)).toEqual([]);
    for await (const found of bucket.scan(filter)) {
      throw new Error(`scan() still yields ${found.path}`);
    }
  });
});
