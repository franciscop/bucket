import { Blob } from "node:buffer";

import FileSystem from "../fs/index.js";
import Backblaze from "../b2/index.js";

import {
  nodeStreamToString,
  webStreamToString,
  textToNodeStream,
  textToWebStream,
} from "./utils.js";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import fsp from "node:fs/promises";

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
  // BackBlaze: Backblaze(),
};

const bytes = await fsp.readFile("./test/bucket/nero.jpg");

describe.each(Object.entries(buckets))("%s", (name, bucket) => {
  beforeAll(() => bucket.info()); // Heat it up
  beforeEach(() => removeTestFiles(bucket));
  afterEach(() => removeTestFiles(bucket));

  describe("Bucket()", () => {
    it("can get the basic info", async () => {
      const info = await bucket.info();
      expect(info.id).toBeDefined();
      expect(info.type).toBe(bucket.type);
    });

    it("can get all of the files", async () => {
      const files = await bucket.list();
      expect(files.length).toEqual(8);
      const keys = Object.keys(files[0]);
      expect(keys).toContain("id");
      expect(keys).toContain("name");
      expect(keys).toContain("path");
    });
  });

  describe("File", () => {
    it("can get file info", async () => {
      const info = await bucket.file("nero.jpg").info();
      // expect(info.id).toEqual(14184022085698);
      expect(info.name).toEqual("nero.jpg");
      // expect(info.path).toEqual("/Users/francisco/projects/bucket/test/bucket/nero.jpg");
      expect(info.exists).toEqual(true);
      expect(info.type).toEqual("image/jpeg");
      expect(info.size).toEqual(175888);
      // expect(info.date).toEqual(new Date("2024-08-30T11 35:36.840Z"));
      // expect(info.url).toEqual(null);
    });

    it("can get deep file info", async () => {
      const info = await bucket.file("deep/readme.txt").info();
      // expect(info.id).toEqual(14184022085698);
      expect(info.name).toEqual("readme.txt");
      expect(info.path.split("/").slice(-2).join("/")).toEqual(
        "deep/readme.txt",
      );
      expect(info.exists).toEqual(true);
      expect(info.type).toEqual("text/plain");
      expect(info.size).toEqual(9);
      // expect(info.date).toEqual(new Date("2024-08-30T11 35:36.840Z"));
      // expect(info.url).toEqual(null);
    });

    it("can get a non-existing file info", async () => {
      const info = await bucket.file("nonexisting.txt").info();
      // expect(info.id).toBe(9874933570189);
      expect(info.name).toEqual("nonexisting.txt");
      // expect(info.path).toEqual("/Users/francisco/projects/bucket/test/bucket/nonexisting.txt");
      expect(info.exists).toEqual(false);
      expect(info.type).toEqual(null);
      expect(info.size).toEqual(0);
      expect(info.date).toEqual(null);
      expect(info.url).toEqual(null);
    });
  });

  describe("Reading data", () => {
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
      expect(info.type).toBe("image/jpeg");
    });

    it("can write a blob", async () => {
      const file = bucket.file(testFile(".jpg"));
      const data = await bucket.file("nero.jpg").blob();
      await file.write(data);
      const info = await file.info();
      expect(info.size).toBe(175888);
      expect(info.type).toBe("image/jpeg");
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
      await textToWebStream("hello5").pipeTo(file.writable());
      expect(await file.text()).toBe("hello5");
    });

    it("can (web) stream to a file", async () => {
      const file = bucket.file(testFile());
      await textToWebStream("hello6").pipeTo(file.writable("web"));
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
