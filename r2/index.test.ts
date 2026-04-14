import CloudflareBucket from "./index.ts";

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
});
