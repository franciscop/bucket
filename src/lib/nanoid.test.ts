import nanoid, { randomName } from "./nanoid.ts";

describe("nanoid", () => {
  it("is 21 url-safe characters by default", () => {
    expect(nanoid()).toHaveLength(21);
    expect(nanoid()).toMatch(/^[A-Za-z0-9]{21}$/);
    expect(nanoid(8)).toHaveLength(8);
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => nanoid()));
    expect(ids.size).toBe(1000);
  });

  it("uses the whole alphabet", () => {
    const seen = new Set(Array.from({ length: 500 }, () => nanoid()).join(""));
    expect(seen.size).toBe(62);
  });
});

describe("randomName", () => {
  it("has no extension for bodies that do not carry a name", () => {
    expect(randomName("hello")).toMatch(/^[A-Za-z0-9]{21}$/);
    expect(randomName(Buffer.from("x"))).toMatch(/^[A-Za-z0-9]{21}$/);
    expect(randomName(new Blob(["x"], { type: "image/png" }))).toMatch(
      /^[A-Za-z0-9]{21}$/,
    );
  });

  it("keeps the extension of a named body", () => {
    expect(randomName(new File(["x"], "photo.PNG"))).toMatch(/\.PNG$/);
    expect(randomName({ name: "a.tar.gz" } as never)).toMatch(/\.gz$/);
  });

  it("takes the extension from the type option, given either way", () => {
    for (const type of ["image/png", "png", ".png", "PNG"]) {
      expect(randomName("x", { type })).toMatch(/^[A-Za-z0-9]{21}\.png$/);
    }
    expect(randomName("x", { type: "text/html; charset=utf-8" })).toMatch(
      /\.html$/,
    );
  });

  it("picks the common extension when a type has several", () => {
    const ext = (type: string) => randomName("x", { type }).slice(21);
    expect(ext("image/jpeg")).toBe(".jpg");
    expect(ext("text/html")).toBe(".html");
    expect(ext("text/plain")).toBe(".txt");
    expect(ext("text/javascript")).toBe(".js");
  });

  it("prefers the type option over the body's own name", () => {
    const named = new File(["x"], "photo.png");
    expect(randomName(named, { type: "image/webp" })).toMatch(/\.webp$/);
  });

  it("falls back to the name for a type it cannot map", () => {
    const named = new File(["x"], "photo.png");
    expect(randomName(named, { type: "application/x-custom" })).toMatch(
      /\.png$/,
    );
    expect(randomName("x", { type: "application/x-custom" })).toMatch(
      /^[A-Za-z0-9]{21}$/,
    );
  });

  it("ignores names that have no usable extension", () => {
    for (const name of [
      "noext",
      ".env",
      "a.",
      "report.2024-final",
      "a." + "z".repeat(13),
    ]) {
      expect(randomName({ name } as never)).toMatch(/^[A-Za-z0-9]{21}$/);
    }
  });
});
