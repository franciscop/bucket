// Every method that does I/O takes an optional AbortSignal. Aborting throws a
// BucketError with code "ABORTED", whose `name` mirrors the standard reason
// ("AbortError", "TimeoutError", or whatever a custom reason is called) so both
// idioms work: `err instanceof BucketError && err.code === "ABORTED"` and
// `err.name === "AbortError"`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BucketError from "../src/lib/BucketError.ts";
import FileSystem from "../src/fs/index.ts";
import S3 from "../src/s3/index.ts";
import R2 from "../src/r2/index.ts";
import GCS from "../src/gcs/index.ts";
import Azure from "../src/azure/index.ts";

const dirs: string[] = [];
const freshBucket = () => {
  const dir = mkdtempSync(join(tmpdir(), "bucket-abort-"));
  dirs.push(dir);
  return FileSystem(dir);
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const aborted = () => AbortSignal.abort();

// Runs fn and returns the error it threw, or null if it resolved.
const caught = async (fn: () => unknown): Promise<any> => {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return null;
};

describe("the shape of an abort error", () => {
  it("is a BucketError with code ABORTED", async () => {
    const bucket = freshBucket();
    await bucket.file("a.txt").write("x");

    const err = await caught(() =>
      bucket.file("a.txt").text({ signal: aborted() }),
    );
    expect(err).toBeInstanceOf(BucketError);
    expect(err.code).toBe("ABORTED");
  });

  it("carries the standard name so err.name === 'AbortError' works", async () => {
    const bucket = freshBucket();
    await bucket.file("a.txt").write("x");

    const err = await caught(() =>
      bucket.file("a.txt").text({ signal: aborted() }),
    );
    expect(err.name).toBe("AbortError");
  });

  it("reports a timeout as a TimeoutError, not an abort", async () => {
    const bucket = freshBucket();
    await bucket.file("a.txt").write("x");

    const signal = AbortSignal.timeout(1);
    await new Promise((r) => setTimeout(r, 15));

    const err = await caught(() => bucket.file("a.txt").text({ signal }));
    expect(err.code).toBe("ABORTED"); // the axis you branch on
    expect(err.name).toBe("TimeoutError"); // the standard flavour
  });

  it("keeps a custom reason on cause", async () => {
    const bucket = freshBucket();
    await bucket.file("a.txt").write("x");

    const reason = new Error("user navigated away");
    const controller = new AbortController();
    controller.abort(reason);

    const err = await caught(() =>
      bucket.file("a.txt").text({ signal: controller.signal }),
    );
    expect(err.cause).toBe(reason);
    expect(err.name).toBe("Error");
    expect(err.code).toBe("ABORTED");
  });

  it("is raised before any provider is involved, so it has no provider", async () => {
    const bucket = freshBucket();
    const err = await caught(() =>
      bucket.file("a.txt").text({ signal: aborted() }),
    );
    expect(err.provider).toBeUndefined();
  });
});

describe("file methods accept a signal", () => {
  const readers = ["text", "json", "arrayBuffer", "blob", "bytes"] as const;

  it("rejects every read method when already aborted", async () => {
    const bucket = freshBucket();
    await bucket.file("a.json").write('{"a":1}');

    for (const method of readers) {
      const file = bucket.file("a.json");
      const err = await caught(() =>
        (file[method] as Function)({ signal: aborted() }),
      );
      expect(`${method}: ${err?.code}`).toBe(`${method}: ABORTED`);
    }
  });

  it("rejects info(), exists() and remove()", async () => {
    const bucket = freshBucket();
    await bucket.file("a.txt").write("x");

    for (const method of ["info", "exists", "remove"] as const) {
      const file = bucket.file("a.txt");
      const err = await caught(() =>
        (file[method] as Function)({ signal: aborted() }),
      );
      expect(`${method}: ${err?.code}`).toBe(`${method}: ABORTED`);
    }
    // remove() aborted means the file is still there
    expect(await bucket.file("a.txt").exists()).toBe(true);
  });

  it("rejects write() through WriteOptions", async () => {
    const bucket = freshBucket();
    const err = await caught(() =>
      bucket.file("new.txt").write("x", { signal: aborted() }),
    );
    expect(err.code).toBe("ABORTED");
    expect(await bucket.file("new.txt").exists()).toBe(false);
  });

  it("rejects copyTo() and moveTo(), leaving the source intact", async () => {
    const bucket = freshBucket();
    await bucket.file("src.txt").write("x");

    expect(
      (
        await caught(() =>
          bucket.file("src.txt").copyTo("c.txt", { signal: aborted() }),
        )
      ).code,
    ).toBe("ABORTED");
    expect(
      (
        await caught(() =>
          bucket.file("src.txt").moveTo("m.txt", { signal: aborted() }),
        )
      ).code,
    ).toBe("ABORTED");

    expect(await bucket.file("src.txt").exists()).toBe(true);
    expect(await bucket.file("c.txt").exists()).toBe(false);
    expect(await bucket.file("m.txt").exists()).toBe(false);
  });
});

describe("bucket methods accept a signal", () => {
  it("rejects list(), count() and remove()", async () => {
    const bucket = freshBucket();
    await bucket.file("a.txt").write("x");

    expect(
      (await caught(() => bucket.list(undefined, { signal: aborted() }))).code,
    ).toBe("ABORTED");
    expect(
      (await caught(() => bucket.count(undefined, { signal: aborted() }))).code,
    ).toBe("ABORTED");
    expect(
      (await caught(() => bucket.remove(/./, { signal: aborted() }))).code,
    ).toBe("ABORTED");
    // The aborted remove() deleted nothing
    expect(await bucket.count()).toBe(1);
  });

  it("rejects scan() at the call, not on the first iteration", async () => {
    const bucket = freshBucket();
    await bucket.file("a.txt").write("x");
    // Same eager-validation contract as an invalid filter.
    const err = await caught(() =>
      bucket.scan(undefined, { signal: aborted() }),
    );
    expect(err.code).toBe("ABORTED");
  });

  it("stops a scan already in progress", async () => {
    const bucket = freshBucket();
    for (let i = 0; i < 5; i++) await bucket.file(`f${i}.txt`).write("x");

    const controller = new AbortController();
    const seen: string[] = [];
    const err = await caught(async () => {
      for await (const file of bucket.scan(undefined, {
        signal: controller.signal,
      })) {
        seen.push(file.path);
        controller.abort();
      }
    });
    expect(err.code).toBe("ABORTED");
    expect(seen.length).toBe(1);
  });

  it("rejects create() and info()", async () => {
    const bucket = freshBucket();
    expect(
      (await caught(() => bucket.create("x", { signal: aborted() }))).code,
    ).toBe("ABORTED");
    expect((await caught(() => bucket.info({ signal: aborted() }))).code).toBe(
      "ABORTED",
    );
  });
});

describe("aborting mid-flight, not just up front", () => {
  it("rejects a read that is already in progress", async () => {
    const bucket = freshBucket();
    // A file big enough that the read does not complete synchronously.
    await bucket.file("big.txt").write("x".repeat(4 * 1024 * 1024));

    const controller = new AbortController();
    const reading = bucket.file("big.txt").text({ signal: controller.signal });
    controller.abort();

    const err = await caught(() => reading);
    expect(err.code).toBe("ABORTED");
  });

  it("does not leave a half-written file behind", async () => {
    const bucket = freshBucket();
    const controller = new AbortController();
    const writing = bucket
      .file("half.txt")
      .write("y".repeat(4 * 1024 * 1024), { signal: controller.signal });
    controller.abort();

    expect((await caught(() => writing)).code).toBe("ABORTED");
    expect(await bucket.file("half.txt").exists()).toBe(false);
  });
});

// ── Remote providers: mocked fetch, so the signal is the only variable ───────

describe("the signal reaches the provider's fetch", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const s3 = () => S3("test-bucket", { id: "x", secret: "y" });

  it("passes the signal to fetch on a read", async () => {
    let seen: unknown = null;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return Promise.resolve(new Response("body"));
    }) as typeof fetch;

    const controller = new AbortController();
    await s3().file("a.txt").text({ signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });

  it("passes the signal to fetch on a listing", async () => {
    let seen: unknown = null;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return Promise.resolve(
        new Response(
          `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`,
        ),
      );
    }) as typeof fetch;

    const controller = new AbortController();
    await s3().list(undefined, { signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });

  it("surfaces a fetch abort as a BucketError, not a raw DOMException", async () => {
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      return Promise.reject(
        (init?.signal as AbortSignal)?.reason ??
          new DOMException("aborted", "AbortError"),
      );
    }) as typeof fetch;

    const err = await caught(() =>
      s3().file("a.txt").text({ signal: aborted() }),
    );
    expect(err).toBeInstanceOf(BucketError);
    expect(err.code).toBe("ABORTED");
    expect(err.name).toBe("AbortError");
  });
});

describe("every provider honours a signal", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Built without credentials and never reached: an already-aborted signal
  // must reject before the first request goes out.
  const providers = () => ({
    S3: S3("b", { id: "x", secret: "y" }),
    R2: R2("b", { id: "x", secret: "y", account: "a", url: "" }),
    GCS: GCS("b", { anonymous: true }),
    Azure: Azure("c", { account: "a", key: "k" }),
    FS: freshBucket(),
  });

  it("rejects reads on every provider without sending a request", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return Promise.resolve(new Response("nope"));
    }) as unknown as typeof fetch;

    for (const [name, bucket] of Object.entries(providers())) {
      const err = await caught(() =>
        bucket.file("a.txt").text({ signal: aborted() }),
      );
      expect(`${name}: ${err?.code}`).toBe(`${name}: ABORTED`);
      expect(`${name}: ${err?.name}`).toBe(`${name}: AbortError`);
    }
    expect(calls).toBe(0);
  });

  it("rejects listings and removes on every provider", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response("nope"))) as unknown as typeof fetch;

    for (const [name, bucket] of Object.entries(providers())) {
      for (const run of [
        () => bucket.list(undefined, { signal: aborted() }),
        () => bucket.count(undefined, { signal: aborted() }),
        () => bucket.remove(/./, { signal: aborted() }),
        () => bucket.scan(undefined, { signal: aborted() }),
        () => bucket.file("a.txt").remove({ signal: aborted() }),
        () => bucket.file("a.txt").info({ signal: aborted() }),
        () => bucket.file("a.txt").write("x", { signal: aborted() }),
      ]) {
        const err = await caught(run);
        expect(`${name}: ${err?.code}`).toBe(`${name}: ABORTED`);
      }
    }
  });
});
