// remove() takes a required RegExp: an `undefined` filter variable used to
// empty the whole bucket. Validation happens before any provider call, so the
// filesystem exercises exactly the same code path as the remote providers.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import FileSystem from "../src/fs/index.ts";
import { assertFilter, requireFilter } from "../src/lib/filter.ts";

const dirs: string[] = [];
const freshBucket = () => {
  const dir = mkdtempSync(join(tmpdir(), "bucket-filter-"));
  dirs.push(dir);
  return FileSystem(dir);
};

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const code = async (fn: () => unknown): Promise<string | undefined> => {
  try {
    await fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
};

describe("filter validation", () => {
  it("requireFilter rejects everything that is not a RegExp", async () => {
    for (const bad of [undefined, null, "hello", 7, {}, [], () => true]) {
      expect(await code(() => requireFilter(bad))).toBe("INVALID_FILTER");
    }
    expect(await code(() => requireFilter(/x/))).toBeUndefined();
  });

  it("assertFilter allows undefined but nothing else odd", async () => {
    expect(await code(() => assertFilter(undefined))).toBeUndefined();
    expect(await code(() => assertFilter(/x/))).toBeUndefined();
    for (const bad of [null, "hello", 7, () => true]) {
      expect(await code(() => assertFilter(bad))).toBe("INVALID_FILTER");
    }
  });

  it("names the alternatives, so the message is actionable", async () => {
    try {
      requireFilter(undefined);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain(".remove(/./)");
      expect(message).toContain(".folder(");
      expect(message).toContain("RegExp");
    }
  });

  it("is raised before any provider is involved", async () => {
    try {
      requireFilter("hello");
    } catch (err) {
      expect((err as { provider?: string }).provider).toBeUndefined();
      expect((err as { status?: number }).status).toBeUndefined();
    }
  });
});

describe("bucket.remove() requires a RegExp", () => {
  it("throws without a filter", async () => {
    const bucket = freshBucket();
    expect(await code(() => bucket.remove(undefined as never))).toBe(
      "INVALID_FILTER",
    );
  });

  it("throws for a string, null, or a function", async () => {
    const bucket = freshBucket();
    for (const bad of ["hello", null, () => true]) {
      expect(await code(() => bucket.remove(bad as never))).toBe(
        "INVALID_FILTER",
      );
    }
  });

  it("deletes nothing when it throws", async () => {
    const bucket = freshBucket();
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      await bucket.file(name).write("x");
    }
    expect(await code(() => bucket.remove(undefined as never))).toBe(
      "INVALID_FILTER",
    );
    expect(await bucket.count()).toBe(3);
  });

  it("empties the bucket with /./", async () => {
    const bucket = freshBucket();
    for (const name of ["a.txt", "b/c.txt"]) await bucket.file(name).write("x");
    expect(await bucket.count()).toBe(2);

    const removed = await bucket.remove(/./);
    expect(removed.length).toBe(2);
    expect(await bucket.count()).toBe(0);
  });
});

describe("list/scan/count keep an optional filter", () => {
  it("work with no argument", async () => {
    const bucket = freshBucket();
    await bucket.file("a.txt").write("x");
    expect((await bucket.list()).length).toBe(1);
    expect(await bucket.count()).toBe(1);
    let seen = 0;
    for await (const _ of bucket.scan()) seen++;
    expect(seen).toBe(1);
  });

  it("reject a non-RegExp instead of ignoring it", async () => {
    const bucket = freshBucket();
    expect(await code(() => bucket.list("x" as never))).toBe("INVALID_FILTER");
    expect(await code(() => bucket.count("x" as never))).toBe("INVALID_FILTER");
    // scan() validates when called, not on the first iteration
    expect(await code(() => bucket.scan("x" as never))).toBe("INVALID_FILTER");
  });
});

describe("a global RegExp filter", () => {
  it("matches every file, not every other one", async () => {
    const bucket = freshBucket();
    for (const n of ["x1.txt", "x2.txt", "x3.txt", "x4.txt"])
      await bucket.file(n).write("-");
    expect((await bucket.list(/x/g)).length).toBe(4);
    expect(await bucket.count(/x/g)).toBe(4);
    expect((await bucket.remove(/x/g)).length).toBe(4);
  });
});
