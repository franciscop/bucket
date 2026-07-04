// Unit tests for resolveContentType: the precedence used by write() to pick a
// content-type. Pure function, so this validates the logic for every backend
// (their integration tests only run against emulators).

import { resolveContentType } from "./fileTypes.ts";

const png = () => new Blob(["x"], { type: "image/png" });

describe("resolveContentType", () => {
  it("prefers the explicit option above all", () => {
    expect(resolveContentType("photo.jpg", png(), { type: "text/csv" })).toBe(
      "text/csv",
    );
  });

  it("then the destination extension (wins over the Blob's type)", () => {
    expect(resolveContentType("photo.jpg", png())).toBe("image/jpeg");
  });

  it("then the Blob's own type when the extension is unknown", () => {
    expect(resolveContentType("upload", png())).toBe("image/png");
    expect(resolveContentType("upload.weirdext", png())).toBe("image/png");
  });

  it("is undefined when nothing applies", () => {
    expect(resolveContentType("upload", "a string")).toBeUndefined();
    expect(resolveContentType("upload", new Blob(["x"]))).toBeUndefined();
  });
});
