import "dotenv/config";

import { pipeline } from "stream/promises";

import Bucket, { ENV_ID, ENV_KEY, ENV_NAME } from "./";

const name = process.env[ENV_NAME];
const id = process.env[ENV_ID];
const key = process.env[ENV_KEY];

const bucket = Bucket(name, { id, key });

describe(`${bucket.name} Shared API`, () => {
  beforeAll(async () => {
    await bucket.remove("/");
    await bucket.write("/readme.md", "Hello world");
    await bucket.write("/hello.txt", "Hello world");
    await bucket.write("/demo/data.csv", "Hello,world");
    await bucket.write("/demo/readme.md", "Hello world");
  });
  afterAll(async () => {
    await bucket.remove("/");
  });

  it("is a function", () => {
    expect(typeof Bucket).toBe("function");
  });

  it("works with both new and await", async () => {
    const inst1 = new Bucket(name, { id, key });
    const inst2 = await Bucket(name, { id, key });
  });

  it("has the correcet methods", () => {
    expect(bucket).toHaveMethod("info");
    expect(bucket).toHaveMethod("count");
    expect(bucket).toHaveMethod("list");
    expect(bucket).toHaveMethod("upload");
    expect(bucket).toHaveMethod("download");
    expect(bucket).toHaveMethod("read");
    expect(bucket).toHaveMethod("write");
    expect(bucket).toHaveMethod("remove");
    expect(bucket).toHaveMethod("exists");
    expect(bucket).toHaveMethod("copy");
    expect(bucket).toHaveMethod("sign");
  });

  it("returns the correct file structure", async () => {
    const files = await bucket.list();
    const keys = Object.keys(files[0]);
    expect(keys).toEqual(["id", "name", "path", "type", "size", "date", "url"]);
    expect(typeof files[0].id).toBe("string");
    expect(typeof files[0].name).toBe("string");
    expect(typeof files[0].path).toBe("string");
    expect(typeof files[0].type).toBe("string");
    expect(typeof files[0].size).toBe("number");
    expect(typeof files[0].date).toBe("object");
    expect(typeof files[0].url).toBe("string");
  });

  it("can retrieve the bucket info", async () => {
    const info = await bucket.info();
    expect(typeof info.id).toBe("string");
  });

  it("can filter on the listing, ignoring slashes", async () => {
    const files = await bucket.list("demo");
    expect(files.map((file) => file.path)).toContain("/demo/data.csv");

    const files2 = await bucket.list("/demo");
    expect(files2.map((file) => file.path)).toContain("/demo/data.csv");

    const files3 = await bucket.list("/demo/");
    expect(files3.map((file) => file.path)).toContain("/demo/data.csv");
  });

  it("can count files", async () => {
    expect(await bucket.count()).toEqual();
  });

  it("can count files with a prefix", async () => {
    const sub = await bucket.count("demo");
    expect(sub).toEqual(2);
  });

  it("can upload and remove a file", async () => {
    expect(await bucket.exists("/upload.txt")).toBe(false);
    await bucket.upload("./readme.md", "/upload.txt");
    expect(await bucket.exists("/upload.txt")).toBe(true);
    await bucket.remove("/upload.txt");
    expect(await bucket.exists("/upload.txt")).toBe(false);
  });

  it("can upload and remove a nested file", async () => {
    expect(await bucket.exists("/uploads/readme.md")).toBe(false);
    await bucket.upload("./readme.md", "/uploads/readme.md");
    expect(await bucket.exists("/uploads/readme.md")).toBe(true);
    await bucket.remove("/uploads/readme.md");
    expect(await bucket.exists("/uploads/readme.md")).toBe(false);
  });

  it("can download a file", async () => {
    expect(await bucket.exists("/readme2.md")).toBe(false);
    // LOL at this hack
    await bucket.download("/readme.md", "./fs/test/readme2.md");
    expect(await bucket.exists("/readme2.md")).toBe(true);
    await bucket.remove("/readme2.md");
    expect(await bucket.exists("/readme2.md")).toBe(false);
  });

  it("can copy a file", async () => {
    expect(await bucket.exists("/uploads/readme2.md")).toBe(false);
    await bucket.copy("/readme.md", "/uploads/readme2.md");
    expect(await bucket.exists("/uploads/readme2.md")).toBe(true);
    await bucket.remove("/uploads/readme2.md");
    expect(await bucket.exists("/uploads/readme2.md")).toBe(false);
  });

  it("can do a simple read", async () => {
    expect(await bucket.read("/readme.md")).toBe("Hello world");
  });

  it("can do multiple reads", async () => {
    const prom = bucket.read("/readme.md");
    expect(await prom).toBe("Hello world");
    expect(await prom).toBe("Hello world");
  });

  it("can use then and catch", async () => {
    expect(await bucket.read("/readme.md")).toBe("Hello world");
    expect(await bucket.read("/readme.md").then((data) => data)).toBe(
      "Hello world"
    );
    expect(await bucket.read("/readme.md").catch((err) => err)).toBe(
      "Hello world"
    );
  });

  it("can handle errors", async () => {
    const err = await bucket.read("/abc.txt").catch((err) => err);
    expect(err.message).toBe(
      "ENOENT: no such file or directory, open './fs/test/abc.txt'"
    );
  });

  it("can pipe files", async () => {
    const readStream = bucket.read("/readme.md");
    const writeStream = bucket.write("/streamed.txt");
    await pipeline(readStream, writeStream);
    expect(await bucket.read("/streamed.txt")).toBe("Hello world");
  });

  it("can handle errors in the pipeline", async () => {
    const readStream = bucket.read("/abc.txt");
    const writeStream = bucket.write("/manual.txt");
    const err = await pipeline(readStream, writeStream).catch((err) => err);
    expect(err.message).toBe(
      "ENOENT: no such file or directory, open './fs/test/abc.txt'"
    );
  });
});
