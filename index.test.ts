// The root entry point: a default namespace with every provider under its
// service name, plus the individual named exports.

import bucket from "./index.ts";
import FileSystem from "./fs/index.ts";
import S3 from "./s3/index.ts";
import CloudflareR2 from "./r2/index.ts";
import GCS from "./gcs/index.ts";
import Azure from "./azure/index.ts";
import BackBlaze from "./b2/index.ts";

describe("default export namespace", () => {
  it("exposes every provider under its service name", () => {
    expect(bucket.FS).toBe(FileSystem);
    expect(bucket.S3).toBe(S3);
    expect(bucket.R2).toBe(CloudflareR2);
    expect(bucket.GCS).toBe(GCS);
    expect(bucket.Azure).toBe(Azure);
    expect(bucket.B2).toBe(BackBlaze);
  });

  it("has exactly the six services", () => {
    expect(Object.keys(bucket).sort()).toEqual([
      "Azure",
      "B2",
      "FS",
      "GCS",
      "R2",
      "S3",
    ]);
  });

  it("creates working buckets", () => {
    const fs = bucket.FS("./fs/test");
    expect(fs.type).toBe("FILESYSTEM");
    expect(fs.file("a/b.txt").path).toBe("a/b.txt");
    expect(bucket.S3("some-bucket").type).toBe("S3");
  });
});
