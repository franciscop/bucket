import { Blob } from "node:buffer";

import FileSystem from "../fs/index.js";
import {
  nodeStreamToString,
  webStreamToString,
  textToNodeStream,
  textToWebStream,
} from "./utils.js";
import { pipeline } from "node:stream/promises";
import fsp from "node:fs/promises";
import { createGzip } from "node:zlib";

const buckets = {
  FileSystem: FileSystem("./test/bucket/"),
};

describe.each(Object.entries(buckets))("%s", (name, bucket) => {
  describe("Bucket()", () => {
    it("can get the basic info", async () => {
      expect(await bucket.info()).toEqual({
        id: "francisco",
        name: "FILESYSTEM",
        path: "/Users/francisco/projects/bucket/test/bucket",
      });
    });

    it("can get file info", async () => {
      expect(await bucket.file("nero.jpg").info()).toEqual({
        id: 14184022085698,
        name: "nero.jpg",
        path: "/Users/francisco/projects/bucket/test/bucket/nero.jpg",
        type: "image/jpeg",
        size: 175888,
        date: new Date("2024-07-01T18:44:09.448Z"),
        url: null,
      });
    });
  });

  describe("Reading data", () => {
    it("is well defined", async () => {
      expect(bucket.name).toEqual("FILESYSTEM");
    });

    it("can read a text file", async () => {
      const data = await bucket.file("test.txt").text();
      expect(data).toBe("hello");
    });

    it("can read a json file", async () => {
      const data = await bucket.file("people.json").json();
      expect(data).toEqual(["John", "Mary", "Sarah"]);
    });

    it("can read a file as a buffer", async () => {
      const data = await bucket.file("nero.jpg").buffer();
      expect(typeof data).toBe("object");
      expect(data.length).toBe(175888);
      expect(Buffer.isBuffer(data)).toBe(true);
    });

    it("can read a file as a blob", async () => {
      const data = await bucket.file("nero.jpg").blob();
      expect(data.size).toBe(175888);
      expect(data instanceof Blob).toBe(true);
    });

    it("can (default=web) stream a file", async () => {
      const stream = await bucket.file("test.txt").readable();
      expect(await webStreamToString(stream)).toBe("hello");
    });

    it("can (web) stream a file", async () => {
      const stream = await bucket.file("test.txt").readable("web");
      expect(await webStreamToString(stream)).toBe("hello");
    });

    it("can (node) stream a file", async () => {
      const stream = await bucket.file("test.txt").readable("node");
      expect(await nodeStreamToString(stream)).toBe("hello");
    });
  });

  describe("Writing data", () => {
    afterEach(async () => {
      const files = ["w1.txt", "deep/w2.txt", "w3.jpg"];
      try {
        await Promise.all(files.map((name) => bucket.file(name).remove()));
      } catch (error) {}
    });

    it("creates a file if it doesn't exist", async () => {
      const file = bucket.file("w1.txt");
      expect(await file.exists()).toBe(false);
      await file.write("hello");
      expect(await file.exists()).toBe(true);
      expect(await file.text()).toBe("hello");
    });

    it("creates the file AND folder if they don't exist", async () => {
      const file = bucket.file("deep/w2.txt");
      expect(await file.exists()).toBe(false);
      await file.write("hello");
      expect(await file.exists()).toBe(true);
      expect(await file.text()).toBe("hello");
    });

    it("can write a File", async () => {
      const dst = bucket.file("w1.txt");
      const src = bucket.file("test.txt");
      await dst.write(src);
      expect(await dst.text()).toBe("hello");
    });

    it("can write a string", async () => {
      const file = bucket.file("w1.txt");
      await file.write("hello1");
      expect(await file.text()).toBe("hello1");
    });

    it("can write a buffer", async () => {
      const file = bucket.file("w2.jpg");
      const data = await bucket.file("nero.jpg").buffer();
      await file.write(data);
      const info = await file.info();
      expect(info.size).toBe(175888);
    });

    it("can write a blob", async () => {
      const file = bucket.file("w3.jpg");
      const data = await bucket.file("nero.jpg").blob();
      await file.write(data);
      const info = await file.info();
      expect(info.size).toBe(175888);
    });

    it("can write a Web Stream", async () => {
      const file = bucket.file("w1.txt");
      await file.write(textToWebStream("hello3"));
      expect(await file.text()).toBe("hello3");
    });

    it("can write a Node Stream", async () => {
      const file = bucket.file("w1.txt");
      await file.write(textToNodeStream("hello4"));
      expect(await file.text()).toBe("hello4");
    });

    it("can (default) stream to a file", async () => {
      const file = bucket.file("w1.txt");
      await pipeline(textToWebStream("hello5"), file.writable());
      expect(await file.text()).toBe("hello5");
    });

    it("can (web) stream to a file", async () => {
      const file = bucket.file("w1.txt");
      await pipeline(textToWebStream("hello6"), file.writable("web"));
      expect(await file.text()).toBe("hello6");
    });

    it("can (node) stream to a file", async () => {
      const file = bucket.file("w1.txt");
      await pipeline(textToNodeStream("hello7"), file.writable("node"));
      expect(await file.text()).toBe("hello7");
    });

    it("can copy a file with (web) default .pipeTo()", async () => {
      const file = bucket.file("w1.txt");
      await bucket
        .file("test.txt")
        .readable()
        .pipeTo(bucket.file("w1.txt").writable());
      expect(await file.text()).toBe("hello");
    });

    it("can copy a file with Web .pipeTo()", async () => {
      const file = bucket.file("w1.txt");
      await bucket
        .file("test.txt")
        .readable("web")
        .pipeTo(bucket.file("w1.txt").writable("web"));
      expect(await file.text()).toBe("hello");
    });

    it("can copy a file with Node .pipe()", async () => {
      const dst = bucket.file("w1.txt");
      const src = bucket.file("test.txt");
      await pipeline(src.readable("node"), dst.writable("node"));
      expect(await dst.text()).toBe("hello");
    });
  });

  // TODO: Need to make sure the folder exists before `.writable()` happens, but
  // if possible without making `.writable()` async
  describe.skip("examples", () => {
    afterEach(async () => {
      const files = ["compressed/w1.zip"];
      try {
        await Promise.all(files.map((name) => bucket.file(name).remove()));
      } catch (error) {}

      if (bucket.name === "FILESYSTEM") {
        await fsp
          .rm("./test/bucket/compressed", { recursive: true })
          .catch((err) => {});
        await fsp
          .rm("./test/bucket/deep", { recursive: true })
          .catch((err) => {});
      }
    });

    it("can zip a single file with pipes", async () => {
      const source = bucket.file("a-1*(a!.txt");
      const target = bucket.file("compressed/w1.zip");
      await pipeline(
        source.readable("node"),
        createGzip(),
        target.writable("node"),
      );
      expect((await source.info()).size).toBe(447);
      const info = await target.info();
      expect(info.type).toBe("application/gzip");
      expect(info.size).toBe(281);
    });
  });
});
