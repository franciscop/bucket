import files from "files";
import BackblazeBucket from "./index.js";

const b2 = BackblazeBucket();

describe("BackblazeBucket", () => {
  const env = process.env;

  beforeAll(async () => {
    await b2.remove("/test.txt");
  });

  beforeEach(() => {
    process.env = { ...env };
  });

  afterEach(() => {
    process.env = env;
  });

  it("works", async () => {
    expect(await b2.info().bucketId).toBe("a1ce8b68d8f873b57e250c14");
  });

  it("can list the files", async () => {
    expect((await b2.list()).length).toBe(8);
  });

  it("can limit how many files to list", async () => {
    expect((await b2.list({ limit: 4 })).length).toBe(4);
  });

  it("can fetch more than the page limit", async () => {
    const limit = process.env.PAGE_SIZE;
    process.env.PAGE_SIZE = 3;
    expect((await b2.list({ limit: 4 })).length).toBe(4);
    process.env.PAGE_SIZE = limit;
  });

  it("can loop though the file list", async () => {
    const all = [];
    for await (let file of b2.list({ limit: 4 })) {
      all.push(file);
    }
    expect(await all.length).toBe(4);
  });

  it("has the correct structure", async () => {
    const files = await b2.list();
    expect(files[0]).toEqual({
      id: "4_za1ce8b68d8f873b57e250c14_f10130b6b0939e4c8_d20210823_m231811_c003_v0312004_t0021",
      name: "data.json",
      path: "/data.json",
      type: "application/json",
      size: 23,
      date: new Date("2021-08-23T23:18:11.000Z"),
      url: "https://f003.backblazeb2.com/file/bucket-demo/data.json",
    });
  });

  it("can download a file", async () => {
    await b2.download("/data.json", "./b2/test/data.txt");
    expect(await files.exists("./b2/test/data.txt")).toBe(true);
    await files.remove("./b2/test/data.txt");
  }, 20000);

  it("can download a file to a new folder", async () => {
    await b2.download("/data.json", "./b2/test/new/data.txt");
    expect(await files.exists("./b2/test/new/data.txt")).toBe(true);
    await files.remove("./b2/test/new/");
  }, 20000);

  it("can upload a file", async () => {
    if (await b2.exists("/test.txt")) {
      await b2.remove("/test.txt");
    }
    expect(await b2.exists("/test.txt")).toBe(false);
    await files.write("./b2/test/test.txt", "Hello world");
    await b2.upload("./b2/test/test.txt", "/test.txt");
    expect(await b2.exists("/test.txt")).toBe(true);
    await b2.remove("/test.txt");
    await files.remove("./b2/test/test.txt");
  }, 20000);

  it("can write a file", async () => {
    if (await b2.exists("/test.txt")) {
      await b2.remove("/test.txt");
    }
    await b2.write("/test.txt", "hello world");
    expect(await b2.exists("/test.txt")).toBe(true);
    await b2.remove("/test.txt");
  }, 20000);
});
