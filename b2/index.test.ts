import BackblazeBucket from "./index.ts";

const b2 = BackblazeBucket();

describe.skip("BackblazeBucket", () => {
  const env = process.env;

  beforeAll(async () => {
    await b2.file("/test.txt").remove();
  });

  beforeEach(() => {
    process.env = { ...env };
  });

  afterEach(() => {
    process.env = env;
  });

  it("works", async () => {
    const info = await b2.info();
    expect(info.id).toBeDefined();
  });

  it("can list the files", async () => {
    expect((await b2.list()).length).toBe(8);
  });

  it("can limit how many files to list", async () => {
    expect((await b2.list()).length).toBeLessThanOrEqual(100);
  });

  it("has the correct structure", async () => {
    const files = await b2.list();
    expect(files[0]).toHaveProperty("id");
    expect(files[0]).toHaveProperty("name");
    expect(files[0]).toHaveProperty("path");
    expect(files[0]).toHaveProperty("type");
    expect(files[0]).toHaveProperty("size");
    expect(files[0]).toHaveProperty("date");
    expect(files[0]).toHaveProperty("url");
  });

  it("can write a file", async () => {
    const file = b2.file("/test.txt");
    expect(await file.exists()).toBe(false);
    await file.write("hello world");
    expect(await file.exists()).toBe(true);
    await file.remove();
  }, 20000);
});
