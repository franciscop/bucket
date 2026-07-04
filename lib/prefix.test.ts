// Unit tests for the folder() prefix helpers. These pure functions are the core
// of folder() for every remote backend (S3/R2/GCS/Azure/B2), whose integration
// tests only run against emulators; testing them here validates the logic with
// no network. When the prefix is "" every helper must be a no-op (back-compat).

import {
  cleanPrefix,
  withPrefix,
  joinPrefix,
  scope,
  subBucket,
} from "./prefix.ts";

describe("cleanPrefix", () => {
  it("normalizes to a bare prefix", () => {
    expect(cleanPrefix("./public/")).toBe("public");
    expect(cleanPrefix("/a//b/")).toBe("a/b");
    expect(cleanPrefix("a/b")).toBe("a/b");
    expect(cleanPrefix("")).toBe("");
  });
});

describe("withPrefix / joinPrefix", () => {
  it("combines a prefix with a child name", () => {
    expect(withPrefix("public", "favicon.ico")).toBe("public/favicon.ico");
    expect(withPrefix("", "favicon.ico")).toBe("favicon.ico");
  });
  it("nests and normalizes folder paths", () => {
    expect(joinPrefix("a", "./b/")).toBe("a/b");
    expect(joinPrefix("", "b")).toBe("b");
    expect(joinPrefix("a/b", "c")).toBe("a/b/c");
  });
});

describe("scope (unscoped bucket is back-compatible)", () => {
  it("no filter matches everything", () => {
    const s = scope("", undefined);
    expect(s.query).toBe("");
    expect(s.test("anything/at/all.txt")).toBe(true);
  });
  it("RegExp matches the full key", () => {
    const s = scope("", /\.txt$/);
    expect(s.query).toBe("");
    expect(s.test("a.txt")).toBe(true);
    expect(s.test("a.jpg")).toBe(false);
  });
});

describe("scope (inside a folder)", () => {
  it("RegExp is tested folder-relative and never leaks out", () => {
    const s = scope("public", /^app\./);
    expect(s.query).toBe("public/");
    expect(s.test("public/app.css")).toBe(true); // relative "app.css"
    expect(s.test("public/other.css")).toBe(false);
    expect(s.test("outside/app.css")).toBe(false);
  });
});

describe("subBucket", () => {
  class Fake {
    PREFIX = "";
    secret = "s";
    prefix() {
      return this.PREFIX;
    }
  }

  it("clones the instance, copies fields, and sets a nested PREFIX", () => {
    const root = new Fake();
    const sub = subBucket(root, "./public/");
    expect(sub).not.toBe(root);
    expect(root.PREFIX).toBe(""); // original untouched
    expect(sub.PREFIX).toBe("public");
    expect(sub.secret).toBe("s"); // fields copied
    expect(sub.prefix()).toBe("public"); // prototype methods bind to the clone
    expect(subBucket(sub, "css").PREFIX).toBe("public/css"); // nests
  });
});
