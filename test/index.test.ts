import { Blob } from "node:buffer";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import fsp from "node:fs/promises";

import {
  nodeStreamToString,
  webStreamToString,
  textToNodeStream,
  textToWebStream,
} from "./utils.ts";
import buckets from "./buckets.ts";

const FIXTURE_DIR = "./test/bucket/";
const FIXTURES = [
  "a-1*(a!.txt",
  "capitals.json",
  "data.csv",
  "data.txt",
  "deep/readme.txt",
  "nero.jpg",
  "people.json",
  "readme.md",
];

// Every test file gets a unique random name, so tests never collide and don't
// need to clean up after each other. Cleanup runs only where a test asserts on
// the whole-bucket state (see the count() describe) plus once at the end. This
// avoids a per-test network round-trip that made B2/R2 runs painfully slow.
const testFile = (ext = "txt"): string =>
  `test${Math.floor(Math.random() * 100000)}.${ext}`;

const removeTestFiles = async (
  bucket: (typeof buckets)[string]["bucket"],
): Promise<void> => {
  try {
    // bucket.remove() batches deletes into one request on S3/R2.
    await bucket.remove(/test[^.]*\..*/);
  } catch (_) {}
};

const seedBucket = async (
  bucket: (typeof buckets)[string]["bucket"],
): Promise<void> => {
  await Promise.all(
    FIXTURES.map(async (path) => {
      const data = await fsp.readFile(FIXTURE_DIR + path);
      await bucket.file(path).write(data);
    }),
  );
};

const unseedBucket = async (
  bucket: (typeof buckets)[string]["bucket"],
): Promise<void> => {
  await Promise.all(FIXTURES.map((path) => bucket.file(path).remove()));
};

for (const [name, { bucket }] of Object.entries(buckets)) {
  describe(name, () => {
    beforeAll(async () => {
      await bucket.info(); // Warm up (auth, etc.)
      await removeTestFiles(bucket); // clear leftovers from an interrupted run
      await seedBucket(bucket);
    });
    afterAll(async () => {
      await removeTestFiles(bucket); // don't litter real buckets with test files
      await unseedBucket(bucket);
    });

    // ── Bucket info ───────────────────────────────────────────────────────────

    describe("Bucket", () => {
      it("can get the basic info", async () => {
        const info = await bucket.info();
        expect(info.id).toBeDefined();
        expect(info.type).toBe(bucket.type);
      });

      it("can list files", async () => {
        const files = await bucket.list();
        expect(Array.isArray(files)).toBe(true);
        if (files.length > 0) {
          const keys = Object.keys(files[0]);
          expect(keys).toContain("name");
          expect(keys).toContain("path");
        }
      });

      it("has exactly the 8 seeded fixture files", async () => {
        const files = await bucket.list();
        expect(files.length).toEqual(8);
      });
    });

    // ── Special characters ────────────────────────────────────────────────────

    describe("XML-special file names", () => {
      // "&" travels through XML on S3/R2/Azure (list responses and the S3/R2
      // batch delete body), so it must escape and decode correctly end to end.
      it("round-trips names with & through list() and remove()", async () => {
        const fname = `test${Math.floor(Math.random() * 100000)}-a&b.txt`;
        await bucket.file(fname).write("xml-chars");
        expect(await bucket.file(fname).text()).toBe("xml-chars");

        const names = (await bucket.list()).map((f) => f.name);
        expect(names).toContain(fname);

        const deleted = await bucket.remove(/-a&b\.txt$/);
        expect(deleted.map((f) => f.name)).toContain(fname);
        expect(await bucket.file(fname).exists()).toBe(false);
      });
    });

    // ── File info ─────────────────────────────────────────────────────────────

    describe("File info", () => {
      it("returns null for a non-existing file", async () => {
        expect(await bucket.file("nonexisting.txt").info()).toBeNull();
      });

      it("can get file info for nero.jpg", async () => {
        const info = await bucket.file("nero.jpg").info();
        expect(info).not.toBeNull();
        expect(info!.type).toEqual("image/jpeg");
        expect(info!.size).toEqual(175888);
        expect(info!.modified).toBeInstanceOf(Date);
        expect(
          info!.version === null || typeof info!.version === "string",
        ).toBe(true);
      });

      it("can get info for a deeply nested file", async () => {
        const info = await bucket.file("deep/readme.txt").info();
        expect(info).not.toBeNull();
        expect(info!.type).toEqual("text/plain");
        expect(info!.size).toEqual(9);
      });
    });

    // ── Reading ───────────────────────────────────────────────────────────────

    describe("Reading data", () => {
      it("can read a text file", async () => {
        expect(await bucket.file("data.txt").text()).toBe("hello");
      });

      it("can read a json file", async () => {
        expect(await bucket.file("people.json").json()).toEqual([
          "John",
          "Mary",
          "Sarah",
        ]);
      });

      it("can read a file as an ArrayBuffer", async () => {
        const data = await bucket.file("nero.jpg").arrayBuffer();
        expect(data instanceof ArrayBuffer).toBe(true);
        expect(data.byteLength).toBe(175888);
      });

      it("can read a file as a Blob", async () => {
        const data = await bucket.file("nero.jpg").blob();
        expect(data instanceof Blob).toBe(true);
        expect(data.size).toBe(175888);
      });

      it("can read a file as bytes", async () => {
        const data = await bucket.file("nero.jpg").bytes();
        expect(data instanceof Uint8Array).toBe(true);
        expect(data.byteLength).toBe(175888);
      });

      it("arrayBuffer and bytes return the same binary content", async () => {
        const ab = await bucket.file("nero.jpg").arrayBuffer();
        const bytes = await bucket.file("nero.jpg").bytes();
        expect(bytes).toEqual(new Uint8Array(ab));
      });

      it("can stream a file (web)", async () => {
        const stream = bucket.file("data.txt").stream();
        expect(
          await webStreamToString(stream as ReadableStream<Uint8Array>),
        ).toBe("hello");
      });

      it("can stream a file (node)", async () => {
        const stream = bucket.file("data.txt").nodeReadable();
        expect(await nodeStreamToString(stream as NodeJS.ReadableStream)).toBe(
          "hello",
        );
      });

      it("stream() and nodeReadable() return the same content", async () => {
        const fromWeb = await webStreamToString(
          bucket.file("data.txt").stream() as ReadableStream<Uint8Array>,
        );
        const fromNode = await nodeStreamToString(
          bucket.file("data.txt").nodeReadable() as NodeJS.ReadableStream,
        );
        expect(fromWeb).toBe(fromNode);
      });
    });

    // ── Reading formats (self-contained) ──────────────────────────────────────

    describe("Reading formats", () => {
      it("arrayBuffer() returns correct binary content", async () => {
        const file = bucket.file(testFile());
        await file.write(new Uint8Array([1, 2, 3, 4, 5]));
        const ab = await file.arrayBuffer();
        expect(ab instanceof ArrayBuffer).toBe(true);
        expect(new Uint8Array(ab)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
      });

      it("bytes() returns correct binary content", async () => {
        const file = bucket.file(testFile());
        await file.write(new Uint8Array([10, 20, 30]));
        const bytes = await file.bytes();
        expect(bytes instanceof Uint8Array).toBe(true);
        expect(bytes).toEqual(new Uint8Array([10, 20, 30]));
      });

      it("blob() returns correct content and size", async () => {
        const file = bucket.file(testFile());
        await file.write("blob content");
        const blob = await file.blob();
        expect(blob instanceof Blob).toBe(true);
        expect(await blob.text()).toBe("blob content");
      });

      it("arrayBuffer() and bytes() are consistent", async () => {
        const file = bucket.file(testFile());
        await file.write(new Uint8Array([7, 8, 9]));
        const ab = await file.arrayBuffer();
        const bytes = await file.bytes();
        expect(bytes).toEqual(new Uint8Array(ab));
      });
    });

    // ── slice() (byte ranges) ─────────────────────────────────────────────────

    describe("slice()", () => {
      const CONTENT = "0123456789"; // 10 bytes, index === value
      let name: string;
      beforeAll(async () => {
        name = testFile("txt");
        await bucket.file(name).write(CONTENT);
      });

      it("reads an explicit byte range (end exclusive)", async () => {
        expect(await bucket.file(name).slice(0, 4).text()).toBe("0123");
        expect(await bucket.file(name).slice(2, 5).text()).toBe("234");
      });

      it("reads from an offset to EOF when end is omitted", async () => {
        expect(await bucket.file(name).slice(4).text()).toBe("456789");
      });

      it("clamps an end past the file size", async () => {
        expect(await bucket.file(name).slice(6, 100).text()).toBe("6789");
      });

      it("yields empty for a zero-length or inverted range", async () => {
        expect(await bucket.file(name).slice(3, 3).text()).toBe("");
      });

      it("reports the clamped slice length as info().size", async () => {
        expect((await bucket.file(name).slice(0, 4).info())!.size).toBe(4);
        expect((await bucket.file(name).slice(6, 100).info())!.size).toBe(4);
        expect((await bucket.file(name).slice(4).info())!.size).toBe(6);
      });

      it("keeps the underlying metadata (type) on a slice", async () => {
        const info = await bucket.file(name).slice(0, 4).info();
        expect(info).not.toBeNull();
        expect(info!.type).toContain("text");
      });

      it("composes: slice of a slice", async () => {
        expect(await bucket.file(name).slice(2, 8).slice(1, 3).text()).toBe(
          "34",
        );
      });

      it("streams the range", async () => {
        const s = bucket
          .file(name)
          .slice(0, 4)
          .stream() as ReadableStream<Uint8Array>;
        expect(await new Response(s).text()).toBe("0123");
      });

      it("bytes() honors the range", async () => {
        const bytes = await bucket.file(name).slice(1, 4).bytes();
        expect(Array.from(bytes)).toEqual([0x31, 0x32, 0x33]);
      });
    });

    // ── Writing (self-contained, runs for every bucket) ───────────────────────

    describe("Writing data", () => {
      it("creates a file that did not exist", async () => {
        const file = bucket.file(testFile());
        expect(await file.exists()).toBe(false);
        await file.write("hello");
        expect(await file.exists()).toBe(true);
        expect(await file.text()).toBe("hello");
      });

      it("creates a file inside a new subdirectory", async () => {
        const file = bucket.file("deep/" + testFile());
        expect(await file.exists()).toBe(false);
        await file.write("hello");
        expect(await file.exists()).toBe(true);
        expect(await file.text()).toBe("hello");
      });

      it("can write a string", async () => {
        const file = bucket.file(testFile());
        await file.write("hello1");
        expect(await file.text()).toBe("hello1");
      });

      it("can write a Buffer", async () => {
        const file = bucket.file(testFile("jpg"));
        await file.write(Buffer.from("buffered"));
        expect(await file.text()).toBe("buffered");
      });

      it("can write a Blob", async () => {
        const file = bucket.file(testFile());
        await file.write(new Blob(["blobbed"]));
        expect(await file.text()).toBe("blobbed");
      });

      it("can write a Web Stream", async () => {
        const file = bucket.file(testFile());
        await file.write(textToWebStream("hello3"));
        expect(await file.text()).toBe("hello3");
      });

      it("can write a Node Stream", async () => {
        const file = bucket.file(testFile());
        await file.write(textToNodeStream("hello4"));
        expect(await file.text()).toBe("hello4");
      });

      it("can copy a file object (file.write(otherFile))", async () => {
        const src = bucket.file(testFile());
        await src.write("source content");
        const dst = bucket.file(testFile());
        await dst.write(src);
        expect(await dst.text()).toBe("source content");
      });

      it("can write a large binary file", async () => {
        const data = await fsp.readFile("./test/bucket/nero.jpg");
        const file = bucket.file(testFile("jpg"));
        await file.write(data);
        const info = await file.info();
        expect(info!.size).toBe(175888);
        expect(info!.type).toBe("image/jpeg");
      });

      it("can write a large Blob (binary)", async () => {
        const src = await fsp.readFile("./test/bucket/nero.jpg");
        const file = bucket.file(testFile(".jpg"));
        await file.write(new Blob([src]));
        const info = await file.info();
        expect(info!.size).toBe(175888);
        expect(info!.type).toBe("image/jpeg");
      });
    });

    // ── Large / chunked uploads ───────────────────────────────────────────────

    describe("large uploads (chunked)", () => {
      // 17 MiB streamed crosses the 8 MiB internal part size twice, so this
      // exercises the provider's chunked upload path (multipart / blocks /
      // resumable) over three parts, driven by the real stream machinery.
      it("round-trips a stream spanning three parts, with headers", async () => {
        const size = 17 * 1024 * 1024;
        const chunk = 256 * 1024;
        const data = Buffer.alloc(size);
        for (let i = 0; i < size; i += 4) data.writeUInt32LE(i, i);
        const name = testFile("bin");

        let offset = 0;
        const source = new ReadableStream<Uint8Array>({
          pull(c) {
            if (offset >= size) return c.close();
            c.enqueue(data.subarray(offset, Math.min(offset + chunk, size)));
            offset += chunk;
          },
        });
        await bucket
          .file(name)
          .write(source, { metadata: { check: "chunked" } });

        // Type and metadata ride on the session-start call in chunked mode,
        // a different request than the single-shot PUT, so assert them here.
        const info = await bucket.file(name).info();
        expect(info!.size).toBe(size);
        expect(info!.type).toBe("application/octet-stream");
        if (bucket.type !== "FILESYSTEM") {
          expect(info!.metadata.check).toBe("chunked");
        }

        // Spot-check bytes at the start, at both part boundaries, and at the
        // end, instead of comparing 17 MiB strings.
        const at = async (pos: number) =>
          Buffer.from(
            await bucket
              .file(name)
              .slice(pos, pos + 4)
              .arrayBuffer(),
          ).readUInt32LE(0);
        expect(await at(0)).toBe(0);
        expect(await at(8 * 1024 * 1024)).toBe(8 * 1024 * 1024);
        expect(await at(16 * 1024 * 1024)).toBe(16 * 1024 * 1024);
        expect(await at(size - 4)).toBe(size - 4);

        await bucket.file(name).remove();
      }, 120000);

      it("an erroring source after escalation cleans up the session", async () => {
        // 10 × 1 MiB crosses the 8 MiB threshold, so a chunked session is
        // open when the source errors: this walks the provider's real abort
        // (AbortMultipartUpload / cancel / session delete), not just a local
        // buffer discard.
        const name = testFile("bin");
        let sent = 0;
        const source = new ReadableStream<Uint8Array>({
          pull(c) {
            if (sent >= 10) return c.error(new Error("boom"));
            c.enqueue(new Uint8Array(1024 * 1024));
            sent++;
          },
        });
        let threw = false;
        try {
          await bucket.file(name).write(source);
        } catch {
          threw = true;
        }
        expect(threw).toBe(true);
        expect(await bucket.file(name).exists()).toBe(false);
      }, 120000);

      it("an erroring source stream leaves no file behind", async () => {
        const name = testFile("bin");
        const source = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array(1024));
          },
          pull(c) {
            c.error(new Error("boom"));
          },
        });
        let threw = false;
        try {
          await bucket.file(name).write(source);
        } catch {
          threw = true;
        }
        expect(threw).toBe(true);
        expect(await bucket.file(name).exists()).toBe(false);
      });
    });

    // ── copy / move / rename ──────────────────────────────────────────────────

    describe("copy()", () => {
      it("creates a duplicate at the new path", async () => {
        const src = bucket.file(testFile());
        await src.write("copy-content");
        const dstPath = testFile();
        await src.copyTo(dstPath);
        expect(await bucket.file(dstPath).text()).toBe("copy-content");
      });

      it("keeps the original intact", async () => {
        const src = bucket.file(testFile());
        await src.write("original");
        await src.copyTo(testFile());
        expect(await src.text()).toBe("original");
      });

      it("can copy into a subdirectory", async () => {
        const src = bucket.file(testFile());
        await src.write("nested-copy");
        const dstPath = "deep/" + testFile();
        await src.copyTo(dstPath);
        expect(await bucket.file(dstPath).text()).toBe("nested-copy");
      });

      it("preserves binary content", async () => {
        const bytes = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
        const src = bucket.file(testFile("bin"));
        await src.write(bytes);
        const dstPath = testFile("bin");
        await src.copyTo(dstPath);
        expect(await bucket.file(dstPath).bytes()).toEqual(bytes);
      });
    });

    describe("move()", () => {
      it("creates the file at the new path", async () => {
        const src = bucket.file(testFile());
        await src.write("move-content");
        const dstPath = testFile();
        await src.moveTo(dstPath);
        expect(await bucket.file(dstPath).text()).toBe("move-content");
      });

      it("removes the original", async () => {
        const src = bucket.file(testFile());
        await src.write("will-move");
        const srcPath = src.path;
        await src.moveTo(testFile());
        expect(await bucket.file(srcPath).exists()).toBe(false);
      });

      it("can move into a subdirectory", async () => {
        const src = bucket.file(testFile());
        await src.write("deep-move");
        const dstPath = "deep/" + testFile();
        await src.moveTo(dstPath);
        expect(await bucket.file(dstPath).text()).toBe("deep-move");
      });
    });

    describe("rename()", () => {
      it("renames the file within the same directory", async () => {
        const src = bucket.file(testFile());
        await src.write("rename-content");
        const newName = testFile();
        await src.rename(newName);
        expect(await bucket.file(newName).text()).toBe("rename-content");
      });

      it("removes the original name", async () => {
        const src = bucket.file(testFile());
        await src.write("will-rename");
        const srcPath = src.path;
        await src.rename(testFile());
        expect(await bucket.file(srcPath).exists()).toBe(false);
      });

      it("renames a file inside a nested directory", async () => {
        const src = bucket.file("nested/" + testFile());
        await src.write("nested-rename");
        const newName = testFile();
        await src.rename(newName);
        expect(await bucket.file("nested/" + newName).text()).toBe(
          "nested-rename",
        );
      });

      it("throws if given a path with a slash", async () => {
        const src = bucket.file(testFile());
        await src.write("x");
        await expect(src.rename("sub/name.txt")).rejects.toThrow();
      });
    });

    // ── file.remove() ─────────────────────────────────────────────────────────

    describe("file.remove()", () => {
      it("removes the file so it no longer exists", async () => {
        const file = bucket.file(testFile());
        await file.write("to be removed");
        expect(await file.exists()).toBe(true);
        await file.remove();
        expect(await file.exists()).toBe(false);
      });

      it("unlink() removes the file (alias of remove)", async () => {
        const file = bucket.file(testFile());
        await file.write("via unlink");
        await file.unlink();
        expect(await file.exists()).toBe(false);
      });
    });

    // ── count() ───────────────────────────────────────────────────────────────

    describe("count()", () => {
      // These assert exact counts, so they need a clean slate; other describes
      // tolerate leftover test files (they use unique names and >= assertions).
      beforeEach(() => removeTestFiles(bucket));

      it("returns 0 when no test files exist", async () => {
        expect(await bucket.count(/^test[^/]*\./)).toBe(0);
      });

      it("counts all written test files", async () => {
        await bucket.file(testFile()).write("a");
        await bucket.file(testFile()).write("b");
        await bucket.file(testFile()).write("c");
        expect(await bucket.count(/^test[^/]*\./)).toBe(3);
      });

      it("respects a filter", async () => {
        await bucket.file(testFile("txt")).write("txt");
        await bucket.file(testFile("jpg")).write("jpg");
        expect(await bucket.count(/\.txt$/)).toBeGreaterThanOrEqual(1);
      });
    });

    // ── Bucket.remove() ───────────────────────────────────────────────────────

    describe("Bucket.remove()", () => {
      it("removes all files matching a filter", async () => {
        await bucket.file(testFile("txt")).write("a");
        await bucket.file(testFile("txt")).write("b");
        await bucket.file(testFile("jpg")).write("c");
        await bucket.remove(/^test[^/]*\.txt$/);
        expect(await bucket.count(/^test[^/]*\.txt$/)).toBe(0);
        expect(await bucket.count(/^test[^/]*\.jpg$/)).toBeGreaterThanOrEqual(
          1,
        );
      });

      it("returns the list of deleted files", async () => {
        await bucket.file(testFile("txt")).write("x");
        await bucket.file(testFile("txt")).write("y");
        const deleted = await bucket.remove(/^test[^/]*\.txt$/);
        expect(deleted.length).toBeGreaterThanOrEqual(2);
        expect(deleted.every((f) => f.name.endsWith(".txt"))).toBe(true);
      });

      it("returns an empty array when nothing matches", async () => {
        const deleted = await bucket.remove(/^test[^/]*\.nonexistent$/);
        expect(deleted).toEqual([]);
      });
    });

    // ── folder() ────────────────────────────────────────────────────────────

    describe("folder()", () => {
      it("reads and writes within the folder", async () => {
        const folder = bucket.folder("nested");
        const fname = testFile("txt");
        await folder.file(fname).write("in-folder");
        expect(await folder.file(fname).text()).toBe("in-folder");
        expect(await folder.file(fname).exists()).toBe(true);
      });

      it("scopes list() and count() to the folder", async () => {
        const folder = bucket.folder("nested");
        const rootName = testFile("txt");
        const folderName = testFile("txt");
        await bucket.file(rootName).write("at-root");
        await folder.file(folderName).write("in-folder");

        const names = (await folder.list()).map((f) => f.name);
        expect(names).toContain(folderName);
        expect(names).not.toContain(rootName);
        expect(await folder.count()).toBeGreaterThanOrEqual(1);
      });

      it("nests folders and normalizes the path", async () => {
        const deep = bucket.folder("./a/").folder("b");
        const fname = testFile("txt");
        await deep.file(fname).write("deep");
        expect(await deep.file(fname).text()).toBe("deep");
        // The same object is reachable from the parent under the combined prefix.
        expect(await bucket.file("a/b/" + fname).text()).toBe("deep");
      });
    });

    // ── path traversal ──────────────────────────────────────────────────────

    describe("path traversal", () => {
      const errorCode = (fn: () => unknown): string | undefined => {
        try {
          fn();
        } catch (err) {
          return (err as { code?: string }).code;
        }
      };

      it("resolves . and .. segments that stay inside the bucket", async () => {
        const fname = testFile("txt");
        await bucket.file(fname).write("safe");
        expect(await bucket.file("deep/../" + fname).text()).toBe("safe");
      });

      it("throws INVALID_PATH when a path escapes the bucket", () => {
        expect(errorCode(() => bucket.file("../escape.txt"))).toBe(
          "INVALID_PATH",
        );
        expect(errorCode(() => bucket.file("a/../../escape.txt"))).toBe(
          "INVALID_PATH",
        );
        expect(errorCode(() => bucket.folder("../escape"))).toBe(
          "INVALID_PATH",
        );
      });

      it("throws INVALID_PATH when a file path escapes its folder", () => {
        const folder = bucket.folder("nested");
        expect(errorCode(() => folder.file("../outside.txt"))).toBe(
          "INVALID_PATH",
        );
      });

      it("folder('../') navigates to the parent, bounded by the bucket root", async () => {
        const fname = testFile();
        await bucket.file(fname).write("at-root");
        const back = bucket.folder("nested").folder("..");
        expect(await back.file(fname).text()).toBe("at-root");
        expect(errorCode(() => bucket.folder("nested").folder("../.."))).toBe(
          "INVALID_PATH",
        );
      });

      it("anchors a leading '/' at the bucket root", async () => {
        const fname = testFile();
        await bucket.file("/" + fname).write("anchored");
        expect(await bucket.file(fname).text()).toBe("anchored");
        // Anchored file() paths still cannot leave the folder they're called on
        expect(errorCode(() => bucket.folder("nested").file("/" + fname))).toBe(
          "INVALID_PATH",
        );
      });

      it("resolves copyTo()/moveTo() destinations against the folder", async () => {
        const folder = bucket.folder("nested");
        const a = testFile();
        const b = testFile();
        const c = testFile();
        await folder.file(a).write("dest");
        await folder.file(a).copyTo(b); // folder-relative
        expect(await bucket.file("nested/" + b).text()).toBe("dest");
        await folder.file(a).copyTo("../" + c); // navigates to the root
        expect(await bucket.file(c).text()).toBe("dest");
        const d = testFile();
        await folder.file(b).moveTo("../" + d); // moveTo navigates too
        expect(await bucket.file(d).text()).toBe("dest");
        expect(await bucket.file("nested/" + b).exists()).toBe(false);
      });

      it("copyTo('dir/') keeps the file name", async () => {
        const a = testFile();
        const src = bucket.file(a);
        await src.write("into-dir");
        await src.copyTo("nested/");
        expect(await bucket.file("nested/" + a).text()).toBe("into-dir");
      });

      it("rename() inside a folder stays in the folder", async () => {
        const folder = bucket.folder("nested");
        const a = testFile();
        const b = testFile();
        await folder.file(a).write("folder-rename");
        await folder.file(a).rename(b);
        expect(await bucket.file("nested/" + b).text()).toBe("folder-rename");
      });

      it("rejects an escaping copyTo()/moveTo() destination", async () => {
        const src = bucket.file(testFile("txt"));
        await src.write("stay");
        const codeOf = async (p: Promise<unknown>) => {
          try {
            await p;
          } catch (err) {
            return (err as { code?: string }).code;
          }
        };
        expect(await codeOf(src.copyTo("../out.txt"))).toBe("INVALID_PATH");
        expect(await codeOf(src.moveTo("../out.txt"))).toBe("INVALID_PATH");
        expect(await src.text()).toBe("stay");
      });
    });

    // ── nested-path filtering ────────────────────────────────────────────────

    describe("nested-path filtering", () => {
      it("filters a RegExp against the full key, not the basename", async () => {
        const name = testFile("txt");
        await bucket.file("nested/" + name).write("x");
        const matched = await bucket.list(new RegExp("^nested/"));
        // `^nested/` can only match via the full key, never the basename, so
        // finding the file proves full-key matching (FS reports absolute paths).
        expect(matched.some((f) => f.name === name)).toBe(true);
        // A basename-only pattern must NOT match the nested key.
        const byBase = await bucket.list(
          new RegExp("^" + name.replace(".", "\\.") + "$"),
        );
        expect(byBase.length).toBe(0);
      });
    });

    // ── error paths ────────────────────────────────────────────────────────────

    describe("error paths", () => {
      it("reading a missing file throws a BucketError with code NOT_FOUND", async () => {
        const missing = bucket.file("missing-" + testFile("txt"));
        let err: { code?: string } | undefined;
        await missing.text().catch((e) => (err = e));
        expect(err?.code).toBe("NOT_FOUND");
      });
    });

    // ── metadata ────────────────────────────────────────────────────────────

    describe("metadata", () => {
      it("round-trips custom metadata (lowercased) via info()", async () => {
        const name = testFile("txt");
        await bucket.file(name).write("x", { metadata: { Foo: "bar" } });
        const info = await bucket.file(name).info();
        expect(typeof info!.metadata).toBe("object");
        // Remote providers store and return custom metadata with lowercase keys;
        // the filesystem has no metadata store and returns {}.
        if (bucket.type !== "FILESYSTEM") {
          expect(info!.metadata.foo).toBe("bar");
        }
      });
    });

    // ── copyTo / moveTo a File ───────────────────────────────────────────────

    describe("copyTo / moveTo a File", () => {
      it("copyTo(file) writes to the destination and keeps the original", async () => {
        const src = bucket.file(testFile("txt"));
        await src.write("payload");
        const dst = bucket.file("copied-" + testFile("txt"));
        await src.copyTo(dst);
        expect(await dst.text()).toBe("payload");
        expect(await src.exists()).toBe(true);
        await dst.remove();
      });

      it("moveTo(file) writes to the destination and removes the original", async () => {
        const src = bucket.file(testFile("txt"));
        await src.write("payload");
        const dst = bucket.file("moved-" + testFile("txt"));
        await src.moveTo(dst);
        expect(await dst.text()).toBe("payload");
        expect(await src.exists()).toBe(false);
        await dst.remove();
      });
    });

    // ── scan() ──────────────────────────────────────────────────────────────

    describe("scan()", () => {
      it("yields only files matching the filter", async () => {
        await bucket.file(testFile("txt")).write("a");
        await bucket.file(testFile("jpg")).write("b");
        const names: string[] = [];
        for await (const f of bucket.scan(/^test[^/]*\.txt$/))
          names.push(f.name);
        expect(names.length).toBeGreaterThanOrEqual(1);
        expect(names.every((n) => n.endsWith(".txt"))).toBe(true);
      });

      it("can be stopped early with break", async () => {
        await bucket.file(testFile("txt")).write("a");
        await bucket.file(testFile("txt")).write("b");
        let count = 0;
        for await (const _ of bucket.scan()) {
          count++;
          break;
        }
        expect(count).toBe(1);
      });
    });

    // ── async iteration ───────────────────────────────────────────────────────

    describe("async iteration (for await)", () => {
      it("yields all files", async () => {
        await bucket.file(testFile()).write("iter-a");
        await bucket.file(testFile()).write("iter-b");
        const seen: string[] = [];
        for await (const file of bucket) {
          if (/^test/.test(file.name)) seen.push(file.name);
        }
        expect(seen.length).toBeGreaterThanOrEqual(2);
      });

      it("yields objects with name and path", async () => {
        await bucket.file(testFile()).write("iter-props");
        for await (const file of bucket) {
          expect(file.name).toBeDefined();
          expect(file.path).toBeDefined();
          break;
        }
      });

      it("result matches bucket.list()", async () => {
        await bucket.file(testFile()).write("iter-match");
        const listed = await bucket.list();
        const iterated: string[] = [];
        for await (const file of bucket) iterated.push(file.path);
        expect(iterated).toEqual(listed.map((f) => f.path));
      });
    });

    // ── Streaming / pipes ─────────────────────────────────────────────────────

    describe("Streaming", () => {
      // writable()

      it("writable(): receives a web ReadableStream", async () => {
        const file = bucket.file(testFile());
        await textToWebStream("hello-writable").pipeTo(
          file.writable() as WritableStream,
        );
        expect(await file.text()).toBe("hello-writable");
      });

      it("writable(): receives binary data correctly", async () => {
        const bytes = new Uint8Array([0xff, 0x00, 0xab, 0xcd]);
        const file = bucket.file(testFile("bin"));
        const ws = file.writable() as WritableStream<Uint8Array>;
        const writer = ws.getWriter();
        await writer.write(bytes);
        await writer.close();
        expect(await file.bytes()).toEqual(bytes);
      });

      it("writable(): multiple chunks are concatenated", async () => {
        const file = bucket.file(testFile());
        const ws = file.writable() as WritableStream<Uint8Array>;
        const writer = ws.getWriter();
        await writer.write(new TextEncoder().encode("foo"));
        await writer.write(new TextEncoder().encode("bar"));
        await writer.close();
        expect(await file.text()).toBe("foobar");
      });

      // nodeWritable()

      it("nodeWritable(): receives a Node Readable via pipeline()", async () => {
        const file = bucket.file(testFile());
        await pipeline(
          textToNodeStream("hello-node-writable"),
          file.nodeWritable() as NodeJS.WritableStream,
        );
        expect(await file.text()).toBe("hello-node-writable");
      });

      it("nodeWritable(): receives binary data correctly", async () => {
        const bytes = new Uint8Array([0x01, 0x02, 0x03]);
        const file = bucket.file(testFile("bin"));
        const { Readable } = await import("node:stream");
        await pipeline(
          Readable.from([Buffer.from(bytes)]),
          file.nodeWritable() as NodeJS.WritableStream,
        );
        expect(await file.bytes()).toEqual(bytes);
      });

      // stream()

      it("stream(): emits correct text content", async () => {
        const file = bucket.file(testFile());
        await file.write("stream-content");
        const result = await webStreamToString(
          file.stream() as ReadableStream<Uint8Array>,
        );
        expect(result).toBe("stream-content");
      });

      it("stream(): emits correct binary content", async () => {
        const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
        const file = bucket.file(testFile("bin"));
        await file.write(bytes);
        const chunks: Uint8Array[] = [];
        const reader = (
          file.stream() as ReadableStream<Uint8Array>
        ).getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const result = new Uint8Array(
          chunks.reduce((acc, c) => acc + c.byteLength, 0),
        );
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.byteLength;
        }
        expect(result).toEqual(bytes);
      });

      it("stream(): can pipeTo writable()", async () => {
        const src = bucket.file(testFile());
        await src.write("pipe-web");
        const dst = bucket.file(testFile());
        await (src.stream() as ReadableStream).pipeTo(
          dst.writable() as WritableStream,
        );
        expect(await dst.text()).toBe("pipe-web");
      });

      // nodeReadable()

      it("nodeReadable(): emits correct text content", async () => {
        const file = bucket.file(testFile());
        await file.write("node-readable-content");
        const result = await nodeStreamToString(
          file.nodeReadable() as NodeJS.ReadableStream,
        );
        expect(result).toBe("node-readable-content");
      });

      it("nodeReadable(): can pipeline into nodeWritable()", async () => {
        const src = bucket.file(testFile());
        await src.write("pipe-node");
        const dst = bucket.file(testFile());
        await pipeline(
          src.nodeReadable() as NodeJS.ReadableStream,
          dst.nodeWritable() as NodeJS.WritableStream,
        );
        expect(await dst.text()).toBe("pipe-node");
      });

      it("nodeReadable(): preserves binary content", async () => {
        const bytes = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
        const src = bucket.file(testFile("bin"));
        const dst = bucket.file(testFile("bin"));
        await src.write(bytes);
        await pipeline(
          src.nodeReadable() as NodeJS.ReadableStream,
          dst.nodeWritable() as NodeJS.WritableStream,
        );
        expect(await dst.bytes()).toEqual(bytes);
      });

      // stream() + nodeWritable() cross-type

      it("stream() content matches nodeReadable() content", async () => {
        const file = bucket.file(testFile());
        await file.write("consistency-check");
        const fromWeb = await webStreamToString(
          file.stream() as ReadableStream<Uint8Array>,
        );
        const fromNode = await nodeStreamToString(
          file.nodeReadable() as NodeJS.ReadableStream,
        );
        expect(fromWeb).toBe(fromNode);
      });
    });

    // ── URL methods ───────────────────────────────────────────────────────────

    describe("URL methods", () => {
      it("publicUrl() returns a string or null", async () => {
        const url = await bucket.file("photo.jpg").publicUrl();
        expect(url === null || typeof url === "string").toBe(true);
      });

      it("signedUrl() returns a string or null", async () => {
        const url = await bucket.file("photo.jpg").signedUrl({ expires: "1h" });
        expect(url === null || typeof url === "string").toBe(true);
      });

      it("uploadUrl() returns a string or null", async () => {
        const url = await bucket.file("photo.jpg").uploadUrl({ expires: "1h" });
        expect(url === null || typeof url === "string").toBe(true);
      });

      it("signedUrl() accepts string durations", async () => {
        const url = await bucket
          .file("photo.jpg")
          .signedUrl({ expires: "30min" });
        expect(url === null || typeof url === "string").toBe(true);
      });
    });

    // ── Interop (Blob / Response / FormData) ──────────────────────────────────

    describe("Interop", () => {
      it("blob() yields a real Blob that serializes through Response", async () => {
        const file = bucket.file(testFile());
        await file.write("blob-interop");
        const blob = await file.blob();
        expect(blob instanceof Blob).toBe(true);
        expect(await new Response(blob).text()).toBe("blob-interop");
      });

      it("stream() is usable directly as a Response body", async () => {
        const file = bucket.file(testFile());
        await file.write("stream-interop");
        const body = file.stream() as ReadableStream<Uint8Array>;
        expect(await new Response(body).text()).toBe("stream-interop");
      });

      it("blob() round-trips through FormData", async () => {
        const file = bucket.file(testFile());
        await file.write("form-interop");
        const form = new FormData();
        form.append("upload", await file.blob(), file.name);
        const back = await new Response(form).formData();
        expect(await (back.get("upload") as File).text()).toBe("form-interop");
      });

      it("can store a fetched Response body (Blob)", async () => {
        const incoming = new Response(new Uint8Array([1, 2, 3, 4, 5]));
        const file = bucket.file(testFile("bin"));
        await file.write(await incoming.blob());
        expect(await file.bytes()).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
      });
    });

    // ── Examples ──────────────────────────────────────────────────────────────

    describe("Examples", () => {
      it("can gzip a file using node pipeline()", async () => {
        const source = bucket.file("a-1*(a!.txt");
        // Diagnostics for the R2 special-character key 404; opt in with DIAG=1.
        if (process.env.DIAG && bucket.type !== "FILESYSTEM") {
          const listed = await bucket.list();
          console.error("[diag] provider:", bucket.type);
          console.error(
            "[diag] listed keys:",
            JSON.stringify(listed.map((f) => f.path)),
          );
          console.error("[diag] source.path:", JSON.stringify(source.path));
          console.error("[diag] source.publicUrl():", source.publicUrl());
          console.error(
            "[diag] source.exists():",
            await source.exists().catch((e) => `ERR ${e}`),
          );
          console.error(
            "[diag] source.text():",
            await source
              .text()
              .then((t) => `len=${t.length}`)
              .catch((e) => `ERR ${e}`),
          );
          console.error(
            "[diag] source.info():",
            JSON.stringify(await source.info().catch((e) => `ERR ${e}`)),
          );
        }
        const target = bucket.file(testFile("gz"));
        await pipeline(
          source.nodeReadable() as NodeJS.ReadableStream,
          createGzip(),
          target.nodeWritable() as NodeJS.WritableStream,
        );
        expect((await source.info())!.size).toBe(447);
        const info = await target.info();
        expect(info!.type).toBe("application/gzip");
        expect(info!.size).toBe(281);
      });
    });
  });
}
