// This test only covers the things specific for this bucket;
// any shared API test is under test/index.test.ts at the root

// FileSystem-specific: paths are bucket-relative like the remote providers.
// A leading "/" anchors at the bucket root (never the OS root), file.path is
// the path within the bucket, and nothing resolves outside the root folder.

import { resolve, join } from "node:path";

import FileSystem from "./index.ts";

const ROOT = resolve("./fs/test");
const bucket = FileSystem("./fs/test/");

const errorCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
};

describe("FileSystem bucket-relative paths", () => {
  it("file.path is the path within the bucket, not the OS path", () => {
    expect(bucket.file("a/b.txt").path).toBe("a/b.txt");
    expect(bucket.folder("a").file("b.txt").path).toBe("a/b.txt");
  });

  it("a leading / means the bucket root, not the filesystem root", () => {
    expect(bucket.file("/b.txt").path).toBe("b.txt");
    expect(bucket.folder("a").file("/a/b.txt").path).toBe("a/b.txt");
    expect(errorCode(() => bucket.folder("a").file("/b.txt"))).toBe(
      "INVALID_PATH",
    );
  });

  it("the OS location is join(root, file.path)", async () => {
    const file = bucket.file("a/os-check.txt");
    await file.write("here");
    const fs = await import("node:fs/promises");
    expect(await fs.readFile(join(ROOT, file.path), "utf-8")).toBe("here");
    await file.remove();
  });

  it("folder('../') climbs back within the root only", () => {
    expect(bucket.folder("a").folder("..").file("x.txt").path).toBe("x.txt");
    expect(errorCode(() => bucket.folder("a").folder("../.."))).toBe(
      "INVALID_PATH",
    );
    expect(errorCode(() => bucket.folder(".."))).toBe("INVALID_PATH");
  });

  it("confines file() to the folder it is called on", () => {
    expect(errorCode(() => bucket.folder("a").file("../b.txt"))).toBe(
      "INVALID_PATH",
    );
    expect(errorCode(() => bucket.file("../secret.txt"))).toBe("INVALID_PATH");
  });

  it("resolves .. segments that stay inside the scope", () => {
    expect(bucket.file("a/../b.txt").path).toBe("b.txt");
  });

  it("failed streaming writes are atomic: old content stays, no temp files", async () => {
    const file = bucket.file("atomic-check.txt");
    await file.write("original");
    const bad = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("partial data that must not land"));
      },
      pull(c) {
        c.error(new Error("boom"));
      },
    });
    let threw = false;
    try {
      await bad.pipeTo(file.writable());
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(await file.text()).toBe("original"); // untouched by the failed write
    const fs = await import("node:fs/promises");
    const leftovers = (await fs.readdir(ROOT)).filter((e) =>
      e.includes(".tmp-"),
    );
    expect(leftovers).toEqual([]);
    await file.remove();
  });

  it("readers never observe a half-written file during a streaming write", async () => {
    const file = bucket.file("atomic-visible.txt");
    await file.write("before");
    // Stream that pauses mid-write so we can peek at the visible content
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const source = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(new TextEncoder().encode("after-"));
        await gate;
        c.enqueue(new TextEncoder().encode("complete"));
        c.close();
      },
    });
    const done = source.pipeTo(file.writable());
    await new Promise((r) => setTimeout(r, 20));
    expect(await file.text()).toBe("before"); // old content still visible
    // The in-progress temp sibling is invisible to listings too
    const listed = (await bucket.list()).map((f) => f.path);
    expect(listed.some((p) => p.includes(".tmp-"))).toBe(false);
    release();
    await done;
    expect(await file.text()).toBe("after-complete");
    await file.remove();
  });

  it("rejects (not hangs) when the temp file cannot be opened", async () => {
    const fs = await import("node:fs/promises");
    const dir = join(ROOT, "locked");
    await fs.mkdir(dir, { recursive: true });
    await fs.chmod(dir, 0o555); // read-only: opening the temp sibling fails
    try {
      let threw = false;
      try {
        await new Blob(["x"])
          .stream()
          .pipeTo(bucket.file("locked/x.txt").writable());
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    } finally {
      await fs.chmod(dir, 0o755);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects OS-style paths that start with the bucket's own root", async () => {
    expect(errorCode(() => bucket.file(ROOT + "/a/b.txt"))).toBe(
      "INVALID_PATH",
    );
    expect(errorCode(() => bucket.file(ROOT))).toBe("INVALID_PATH");
    expect(errorCode(() => bucket.folder(ROOT + "/a"))).toBe("INVALID_PATH");
    try {
      bucket.file(ROOT + "/a/b.txt");
    } catch (err) {
      expect((err as Error).message).toContain('Did you mean "a/b.txt"');
    }
    // The same guard covers copy/move destinations
    const src = bucket.file("guard-src.txt");
    await src.write("guarded");
    try {
      await src.copyTo(ROOT + "/guard-dst.txt");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("INVALID_PATH");
    }
    await src.remove();
  });
});
