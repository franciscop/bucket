import FileBucket from "./index.js";

let demoFiles = [];

const bucket = FileBucket("./fs/test");

describe("FileSystem", () => {
  beforeAll(async () => {
    await bucket.write("/test.txt", "Hello world");
    await bucket.write("/deep/deeper/map.txt", "Here be dragons");
    demoFiles = await bucket.list();
  });

  afterAll(async () => {
    await bucket.remove("/");
  });

  it("can be initialized with different prefixes", async () => {
    const bucket = FileBucket("fs/test");
    const files = await bucket.list();
    // Simulates that folder as the root one
    expect(files).toEqual(demoFiles);

    const bucket2 = FileBucket("/fs/test");
    const files2 = await bucket.list();
    // Simulates that folder as the root one
    expect(files2).toEqual(demoFiles);

    const bucket3 = FileBucket("./fs/test");
    const files3 = await bucket.list();
    // Simulates that folder as the root one
    expect(files3).toEqual(demoFiles);
  });
});
