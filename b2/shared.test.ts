import "dotenv/config";

import { pipeline } from "stream/promises";

import BackBlazeV2 from "./index2.ts";

const name = process.env.B2_BUCKET || "";
const id = process.env.B2_APPLICATION_KEY_ID || "";
const secret = process.env.B2_APPLICATION_KEY || "";

const bucket = BackBlazeV2(name, { id, secret });

describe.skip(`${bucket.name} Shared API`, () => {
  beforeAll(async () => {
    console.log("A");
    console.log(await bucket.list());
    console.log("B");
    await bucket.clear("/");
    console.log("C");
    console.log(await bucket.list());
    console.log("D");
    await bucket.write("/readme.md", "Hello world");
    await bucket.write("/hello.txt", "Hello world");
    await bucket.write("/demo/data.csv", "Hello,world");
    await bucket.write("/demo/readme.md", "Hello world");
    console.log("E");
    console.log(await bucket.list());
    console.log("F");
  });

  afterAll(async () => {
    await bucket.clear("/");
  });

  it("is a function", () => {
    expect(typeof BackBlazeV2).toBe("function");
  });

  it("has the correct methods", () => {
    expect(typeof bucket.info).toBe("function");
    expect(typeof bucket.count).toBe("function");
    expect(typeof bucket.list).toBe("function");
    expect(typeof bucket.upload).toBe("function");
    expect(typeof bucket.download).toBe("function");
    expect(typeof bucket.write).toBe("function");
    expect(typeof bucket.remove).toBe("function");
    expect(typeof bucket.exists).toBe("function");
  });

  it("returns the correct file structure", async () => {
    const files = await bucket.list();
    const keys = Object.keys(files[0] as object);
    expect(keys).toEqual(["id", "name", "path", "type", "size", "date", "url"]);
    expect(typeof (files[0] as { id: string }).id).toBe("string");
    expect(typeof (files[0] as { name: string }).name).toBe("string");
    expect(typeof (files[0] as { path: string }).path).toBe("string");
    expect(typeof (files[0] as { type: string }).type).toBe("string");
    expect(typeof (files[0] as { size: number }).size).toBe("number");
    expect(typeof (files[0] as { date: Date }).date).toBe("object");
    expect(typeof (files[0] as { url: string }).url).toBe("string");
  });

  it("can retrieve the bucket info", async () => {
    const info = await bucket.info();
    expect(typeof (info as { id: string }).id).toBe("string");
  });

  it("can filter on the listing, ignoring slashes", async () => {
    const files = await bucket.list("demo");
    expect((files as { path: string }[]).map((file) => file.path)).toContain(
      "/demo/data.csv",
    );

    const files2 = await bucket.list("/demo");
    expect((files2 as { path: string }[]).map((file) => file.path)).toContain(
      "/demo/data.csv",
    );

    const files3 = await bucket.list("/demo/");
    expect((files3 as { path: string }[]).map((file) => file.path)).toContain(
      "/demo/data.csv",
    );
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
});
