import { Blob } from "node:buffer";

import FileSystem from "../fs/index.js";

import {
  nodeStreamToString,
  webStreamToString,
  textToNodeStream,
  textToWebStream,
} from "./utils.js";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const testFile = (ext = "txt") =>
  `test${Math.floor(Math.random() * 100000)}.${ext}`;

const removeTestFiles = async (bucket) => {
  try {
    const files = await bucket.list(/test[^\.]*\..*/);
    await Promise.all(files.map((file) => file.remove()));
  } catch (error) {}
};

const buckets = {
  FileSystem: FileSystem("./test/bucket/"),
};

describe.each(Object.entries(buckets))("%s", (name, bucket) => {
  beforeEach(() => removeTestFiles(bucket));
  afterEach(() => removeTestFiles(bucket));

  describe("Bucket()", () => {
    it("can get the basic info", async () => {
      expect(await bucket.info()).toEqual({
        id: "francisco",
        name: "FILESYSTEM",
        path: "/Users/francisco/projects/bucket/test/bucket",
      });
    });

    it("can get all of the files", async () => {
      expect((await bucket.list()).length).toEqual(7);
    });

    it("can get file info", async () => {
      expect(await bucket.file("nero.jpg").info()).toEqual({
        id: 14184022085698,
        name: "nero.jpg",
        path: "/Users/francisco/projects/bucket/test/bucket/nero.jpg",
        exists: true,
        type: "image/jpeg",
        size: 175888,
        date: new Date("2024-08-30T11:35:36.840Z"),
        url: null,
      });
    });

    it("can get a non-existing file info", async () => {
      expect(await bucket.file("nonexisting.txt").info()).toEqual({
        id: 9874933570189,
        name: "nonexisting.txt",
        path: "/Users/francisco/projects/bucket/test/bucket/nonexisting.txt",
        exists: false,
        type: null,
        size: 0,
        date: null,
        url: null,
      });
    });
  });

  describe("Reading data", () => {
    it("is well defined", async () => {
      expect(bucket.name).toEqual("FILESYSTEM");
    });

    it("can read a text file", async () => {
      const data = await bucket.file("data.txt").text();
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
      const stream = await bucket.file("data.txt").readable();
      expect(await webStreamToString(stream)).toBe("hello");
    });

    it("can (web) stream a file", async () => {
      const stream = await bucket.file("data.txt").readable("web");
      expect(await webStreamToString(stream)).toBe("hello");
    });

    it("can (node) stream a file", async () => {
      const stream = await bucket.file("data.txt").readable("node");
      expect(await nodeStreamToString(stream)).toBe("hello");
    });
  });

  describe("Writing data", () => {
    it("creates a file if it doesn't exist", async () => {
      const file = bucket.file(testFile());
      expect(await file.exists()).toBe(false);
      await file.write("hello");
      expect(await file.exists()).toBe(true);
      expect(await file.text()).toBe("hello");
    });

    it("creates the file AND folder if they don't exist", async () => {
      const file = bucket.file("deep/" + testFile());
      expect(await file.exists()).toBe(false);
      await file.write("hello");
      expect(await file.exists()).toBe(true);
      expect(await file.text()).toBe("hello");
    });

    it("can write a File", async () => {
      const src = bucket.file("data.txt");
      const dst = bucket.file(testFile());
      await dst.write(src);
      expect(await dst.text()).toBe("hello");
    });

    it("can write a string", async () => {
      const file = bucket.file(testFile());
      await file.write("hello1");
      expect(await file.text()).toBe("hello1");
    });

    it("can write a buffer", async () => {
      const file = bucket.file(testFile("jpg"));
      const data = await bucket.file("nero.jpg").buffer();
      await file.write(data);
      const info = await file.info();
      expect(info.size).toBe(175888);
    });

    it("can write a blob", async () => {
      const file = bucket.file(testFile(".jpg"));
      const data = await bucket.file("nero.jpg").blob();
      await file.write(data);
      const info = await file.info();
      expect(info.size).toBe(175888);
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

    it("can (default) stream to a file", async () => {
      const file = bucket.file(testFile());
      await pipeline(textToWebStream("hello5"), file.writable());
      expect(await file.text()).toBe("hello5");
    });

    it("can (web) stream to a file", async () => {
      const file = bucket.file(testFile());
      await pipeline(textToWebStream("hello6"), file.writable("web"));
      expect(await file.text()).toBe("hello6");
    });

    it("can (node) stream to a file", async () => {
      const file = bucket.file(testFile());
      await pipeline(textToNodeStream("hello7"), file.writable("node"));
      expect(await file.text()).toBe("hello7");
    });

    it("can copy a file with (web) default .pipeTo()", async () => {
      const file = bucket.file(testFile());
      await bucket.file("data.txt").readable().pipeTo(file.writable());
      expect(await file.text()).toBe("hello");
    });

    it("can copy a file with Web .pipeTo()", async () => {
      const src = bucket.file("data.txt");
      const dst = bucket.file(testFile());
      await src.readable("web").pipeTo(dst.writable("web"));
      expect(await dst.text()).toBe("hello");
    });

    it("can copy a file with Node .pipe()", async () => {
      const dst = bucket.file(testFile());
      const src = bucket.file("data.txt");
      await pipeline(src.readable("node"), dst.writable("node"));
      expect(await dst.text()).toBe("hello");
    });
  });

  // TODO: Need to make sure the folder exists before `.writable()` happens, but
  // if possible without making `.writable()` async
  describe("examples", () => {
    it("can zip a single file with pipes", async () => {
      const source = bucket.file("a-1*(a!.txt");
      const target = bucket.file(testFile("zip"));
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
