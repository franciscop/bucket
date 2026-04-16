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

const testFile = (ext = "txt"): string =>
  `test${Math.floor(Math.random() * 100000)}.${ext}`;

const removeTestFiles = async (
  bucket: (typeof buckets)[string]["bucket"],
): Promise<void> => {
  try {
    const files = await bucket.list(/test[^.]*\..*/);
    await Promise.all(files.map((f) => f.remove()));
  } catch (_) {}
};

for (const [name, { bucket, seeded }] of Object.entries(buckets)) {
  describe(name, () => {
    beforeAll(() => bucket.info()); // Warm up (auth, etc.)
    beforeEach(() => removeTestFiles(bucket));
    afterEach(() => removeTestFiles(bucket));

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
          expect(keys).toContain("id");
          expect(keys).toContain("name");
          expect(keys).toContain("path");
        }
      });

      if (seeded) {
        it("has exactly the 8 seeded test files", async () => {
          const files = await bucket.list();
          expect(files.length).toEqual(8);
        });
      }
    });

    // ── File info ─────────────────────────────────────────────────────────────

    describe("File info", () => {
      it("returns exists: false for a non-existing file", async () => {
        const info = await bucket.file("nonexisting.txt").info();
        expect(info.name).toEqual("nonexisting.txt");
        expect(info.exists).toEqual(false);
        expect(info.type).toEqual(null);
        expect(info.size).toEqual(0);
        expect(info.date).toEqual(null);
        expect(info.url).toEqual(null);
      });

      if (seeded) {
        it("can get file info for nero.jpg", async () => {
          const info = await bucket.file("nero.jpg").info();
          expect(info.name).toEqual("nero.jpg");
          expect(info.exists).toEqual(true);
          expect(info.type).toEqual("image/jpeg");
          expect(info.size).toEqual(175888);
        });

        it("can get info for a deeply nested file", async () => {
          const info = await bucket.file("deep/readme.txt").info();
          expect(info.name).toEqual("readme.txt");
          expect(info.path.split("/").slice(-2).join("/")).toEqual(
            "deep/readme.txt",
          );
          expect(info.exists).toEqual(true);
          expect(info.type).toEqual("text/plain");
          expect(info.size).toEqual(9);
        });
      }
    });

    // ── Reading (requires seeded data) ────────────────────────────────────────

    if (seeded) {
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
          expect(
            await nodeStreamToString(stream as NodeJS.ReadableStream),
          ).toBe("hello");
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
    }

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
        expect(info.size).toBe(175888);
        expect(info.type).toBe("image/jpeg");
      });

      it("can write a large Blob (binary)", async () => {
        const data = await bucket
          .file(testFile("jpg"))
          .write(new Blob([await fsp.readFile("./test/bucket/nero.jpg")]))
          .then(() => bucket.file(testFile("jpg")));
        // write a fresh one instead
        const src = await fsp.readFile("./test/bucket/nero.jpg");
        const file = bucket.file(testFile(".jpg"));
        await file.write(new Blob([src]));
        const info = await file.info();
        expect(info.size).toBe(175888);
        expect(info.type).toBe("image/jpeg");
      });
    });

    // ── Write options ─────────────────────────────────────────────────────────


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
    });

    // ── count() ───────────────────────────────────────────────────────────────

    describe("count()", () => {
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
        expect(await bucket.count(/^test[^/]*\.jpg$/)).toBeGreaterThanOrEqual(1);
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

      it("yields objects with id, name, path", async () => {
        await bucket.file(testFile()).write("iter-props");
        for await (const file of bucket) {
          expect(file.id).toBeDefined();
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
      it("publicUrl() returns a string or null", () => {
        const url = bucket.file("photo.jpg").publicUrl();
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
        const url = await bucket.file("photo.jpg").signedUrl({ expires: "30min" });
        expect(url === null || typeof url === "string").toBe(true);
      });
    });

    // ── Examples ──────────────────────────────────────────────────────────────

    if (seeded) {
      describe("Examples", () => {
        it("can gzip a file using node pipeline()", async () => {
          const source = bucket.file("a-1*(a!.txt");
          const target = bucket.file(testFile("zip"));
          await pipeline(
            source.nodeReadable() as NodeJS.ReadableStream,
            createGzip(),
            target.nodeWritable() as NodeJS.WritableStream,
          );
          expect((await source.info()).size).toBe(447);
          const info = await target.info();
          expect(info.type).toBe("application/gzip");
          expect(info.size).toBe(281);
        });
      });
    }
  });
}
