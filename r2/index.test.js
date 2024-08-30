import CloudflareBucket from "./index.js";

const r2 = CloudflareBucket();

describe.skip("Cloudflare R2 (S3)", () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
  });

  afterEach(() => {
    process.env = env;
  });

  it("can list the files", async () => {
    const items = await r2.list();
    expect(items[0]).toEqual({
      id: "7efe113aba22926cd825dd5e5ad71b62",
      name: "2013-09-21 16.10.40.jpg",
      path: "/2013-09-21 16.10.40.jpg",
      type: "jpg",
      size: 2979361,
      date: new Date("2024-06-08T16:52:21.263Z"),
    });
  });

  it("can check if a file exists", async () => {
    expect(await r2.exists("abc")).toBe(false);
    expect(await r2.exists("2013-11-01 16.32.42.jpg")).toBe(true);
  });

  // it("can limit how many files to list", async () => {
  //   expect((await r2.list({ limit: 4 })).length).toBe(4);
  // });

  // it("can fetch more than the page limit", async () => {
  //   const limit = process.env.PAGE_SIZE;
  //   process.env.PAGE_SIZE = 3;
  //   expect((await r2.list({ limit: 4 })).length).toBe(4);
  //   process.env.PAGE_SIZE = limit;
  // });

  // it("can loop though the file list", async () => {
  //   const all = [];
  //   for await (let file of b2.list({ limit: 4 })) {
  //     all.push(file);
  //   }
  //   expect(await all.length).toBe(4);
  // });

  // it("has the correct structure", async () => {
  //   const files = await b2.list();
  //   expect(files[0]).toEqual({
  //     id: "4_za1ce8b68d8f873b57e250c14_f10130b6b0939e4c8_d20210823_m231811_c003_v0312004_t0021",
  //     name: "data.json",
  //     path: "/data.json",
  //     type: "application/json",
  //     size: 23,
  //     date: new Date("2021-08-23T23:18:11.000Z"),
  //     url: "https://f003.backblazeb2.com/file/bucket-demo/data.json",
  //   });
  // });

  // it("can download a file", async () => {
  //   await b2.download("/data.json", "./b2/test/data.txt");
  //   expect(await files.exists("./b2/test/data.txt")).toBe(true);
  //   await files.remove("./b2/test/data.txt");
  // }, 20000);

  // it("can download a file to a new folder", async () => {
  //   await b2.download("/data.json", "./b2/test/new/data.txt");
  //   expect(await files.exists("./b2/test/new/data.txt")).toBe(true);
  //   await files.remove("./b2/test/new/");
  // }, 20000);

  // it("can upload a file", async () => {
  //   if (await b2.exists("/test.txt")) {
  //     await b2.remove("/test.txt");
  //   }
  //   expect(await b2.exists("/test.txt")).toBe(false);
  //   await files.write("./b2/test/test.txt", "Hello world");
  //   await b2.upload("./b2/test/test.txt", "/test.txt");
  //   expect(await b2.exists("/test.txt")).toBe(true);
  //   await b2.remove("/test.txt");
  //   await files.remove("./b2/test/test.txt");
  // }, 20000);

  // it("can write a file", async () => {
  //   if (await b2.exists("/test.txt")) {
  //     await b2.remove("/test.txt");
  //   }
  //   await b2.write("/test.txt", "hello world");
  //   expect(await b2.exists("/test.txt")).toBe(true);
  //   await b2.remove("/test.txt");
  // }, 20000);
});
