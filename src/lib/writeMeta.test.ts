// The four providers that map write options onto the wire all go through
// here, so the normalization is asserted once.
import { writeMeta, metaHeaders } from "./writeMeta.ts";

describe("writeMeta", () => {
  it("resolves the type from the extension", () => {
    expect(writeMeta("a.html", {}).type).toBe("text/html");
    expect(writeMeta("a.unknown-ext", {}).type).toBeNull();
  });

  it("prefers an explicit type over the extension", () => {
    expect(writeMeta("a.txt", { type: "text/csv" }).type).toBe("text/csv");
    // An extension or a bare name works too, not just a full mime type
    expect(writeMeta("a.txt", { type: "csv" }).type).toBe("text/csv");
    expect(writeMeta("a.txt", { type: ".csv" }).type).toBe("text/csv");
  });

  it("lowercases metadata keys, since they travel as headers", () => {
    expect(
      writeMeta("a.txt", { metadata: { Owner: "ana", X: "1" } }).metadata,
    ).toEqual({ owner: "ana", x: "1" });
  });

  it("carries cacheControl and disposition through untouched", () => {
    const meta = writeMeta("a.txt", {
      cacheControl: "max-age=60",
      disposition: 'attachment; filename="a.txt"',
    });
    expect(meta.cacheControl).toBe("max-age=60");
    expect(meta.disposition).toBe('attachment; filename="a.txt"');
  });

  it("defaults to no metadata rather than undefined", () => {
    expect(writeMeta("a.txt", {}).metadata).toEqual({});
    expect(writeMeta("a.txt").metadata).toEqual({});
  });
});

describe("metaHeaders", () => {
  const meta = writeMeta("a.txt", {
    type: "text/csv",
    cacheControl: "max-age=60",
    disposition: "inline",
    metadata: { Owner: "ana" },
  });

  it("renders S3's names", () => {
    expect(
      metaHeaders(meta, {
        provider: "TEST",
        type: "Content-Type",
        cacheControl: "Cache-Control",
        disposition: "Content-Disposition",
        metaPrefix: "x-amz-meta-",
      }),
    ).toEqual({
      "Content-Type": "text/csv",
      "Cache-Control": "max-age=60",
      "Content-Disposition": "inline",
      "x-amz-meta-owner": "ana",
    });
  });

  it("renders Azure's names", () => {
    expect(
      metaHeaders(meta, {
        provider: "TEST",
        type: "x-ms-blob-content-type",
        cacheControl: "x-ms-blob-cache-control",
        disposition: "x-ms-blob-content-disposition",
        metaPrefix: "x-ms-meta-",
      }),
    ).toEqual({
      "x-ms-blob-content-type": "text/csv",
      "x-ms-blob-cache-control": "max-age=60",
      "x-ms-blob-content-disposition": "inline",
      "x-ms-meta-owner": "ana",
    });
  });

  it("omits the fields a provider does not name", () => {
    // B2 carries the type in its own header, so the map leaves it out
    expect(
      metaHeaders(meta, {
        provider: "TEST",
        cacheControl: "b2-cache-control",
        disposition: "b2-content-disposition",
        metaPrefix: "",
      }),
    ).toEqual({
      "b2-cache-control": "max-age=60",
      "b2-content-disposition": "inline",
      owner: "ana",
    });
  });

  it("emits nothing for options that were not set", () => {
    const bare = writeMeta("a.unknown-ext", {});
    expect(
      metaHeaders(bare, {
        provider: "TEST",
        type: "Content-Type",
        cacheControl: "Cache-Control",
        metaPrefix: "x-amz-meta-",
      }),
    ).toEqual({});
  });
});
