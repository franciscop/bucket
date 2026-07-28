// Unit tests for the path/prefix helpers. These pure functions are the core of
// file(), folder() and copy/move destinations for every backend (including the
// filesystem), whose integration tests only run against emulators; testing
// them here validates the logic with no network.

import {
  resolvePath,
  fileKey,
  folderKey,
  destKey,
  scope,
  subBucket,
} from "./prefix.ts";

const errorCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
};

describe("resolvePath", () => {
  it("normalizes to a bare key", () => {
    expect(resolvePath("", "./public/")).toBe("public");
    expect(resolvePath("", "a//b/")).toBe("a/b");
    expect(resolvePath("", "a/b")).toBe("a/b");
    expect(resolvePath("", "")).toBe("");
  });
  it("resolves . and .. segments against the base", () => {
    expect(resolvePath("", "a/../b.txt")).toBe("b.txt");
    expect(resolvePath("a", "b/../c")).toBe("a/c");
    expect(resolvePath("a/b", "..")).toBe("a");
  });
  it("anchors a leading / at the bucket root", () => {
    expect(resolvePath("a/b", "/x")).toBe("x");
    expect(resolvePath("a", "/a/x")).toBe("a/x");
    expect(resolvePath("", "/x")).toBe("x");
  });
  it("throws INVALID_PATH when climbing above the bucket root", () => {
    expect(errorCode(() => resolvePath("", "../x"))).toBe("INVALID_PATH");
    expect(errorCode(() => resolvePath("a", "../../x"))).toBe("INVALID_PATH");
    expect(errorCode(() => resolvePath("", "/../x"))).toBe("INVALID_PATH");
  });
  it("throws INVALID_PATH on backslashes (URL parsers treat them as /)", () => {
    expect(errorCode(() => resolvePath("", "..\\x"))).toBe("INVALID_PATH");
    expect(errorCode(() => resolvePath("", "a\\b"))).toBe("INVALID_PATH");
  });
});

describe("fileKey (file names are confined to their folder)", () => {
  it("combines a prefix with a child name", () => {
    expect(fileKey("public", "favicon.ico")).toBe("public/favicon.ico");
    expect(fileKey("", "favicon.ico")).toBe("favicon.ico");
  });
  it("allows any syntax whose result stays inside the folder", () => {
    expect(fileKey("a", "b/../x")).toBe("a/x");
    expect(fileKey("a", "/a/x")).toBe("a/x");
    expect(fileKey("a", "../a/x")).toBe("a/x");
  });
  it("throws INVALID_PATH when the result lands outside the folder", () => {
    expect(errorCode(() => fileKey("a", "../x"))).toBe("INVALID_PATH");
    expect(errorCode(() => fileKey("a", "/x"))).toBe("INVALID_PATH");
    expect(errorCode(() => fileKey("", "../x"))).toBe("INVALID_PATH");
  });
  it("throws INVALID_PATH when the result is not a file", () => {
    expect(errorCode(() => fileKey("", "./"))).toBe("INVALID_PATH");
    expect(errorCode(() => fileKey("", "/"))).toBe("INVALID_PATH");
    expect(errorCode(() => fileKey("a", ".."))).toBe("INVALID_PATH");
  });
});

describe("folderKey (folders navigate, bounded by the bucket root)", () => {
  it("nests and normalizes folder paths", () => {
    expect(folderKey("a", "./b/")).toBe("a/b");
    expect(folderKey("", "b")).toBe("b");
    expect(folderKey("a/b", "c")).toBe("a/b/c");
  });
  it("navigates with .. and /", () => {
    expect(folderKey("a/b", "../c")).toBe("a/c");
    expect(folderKey("a", "..")).toBe("");
    expect(folderKey("a/b", "/")).toBe("");
    expect(folderKey("a/b", "/c")).toBe("c");
  });
  it("throws INVALID_PATH above the bucket root", () => {
    expect(errorCode(() => folderKey("", ".."))).toBe("INVALID_PATH");
    expect(errorCode(() => folderKey("a", "../.."))).toBe("INVALID_PATH");
  });
});

describe("destKey (copy/move destinations navigate like folders)", () => {
  it("resolves relative to the owning folder", () => {
    expect(destKey("a", "b.txt", "x.png")).toBe("a/b.txt");
    expect(destKey("", "b.txt", "x.png")).toBe("b.txt");
  });
  it("navigates with .. and anchors with /", () => {
    expect(destKey("a", "../b.txt", "x.png")).toBe("b.txt");
    expect(destKey("a", "/b.txt", "x.png")).toBe("b.txt");
  });
  it("a trailing / keeps the file name", () => {
    expect(destKey("", "photos/", "x.png")).toBe("photos/x.png");
    expect(destKey("a", "../", "x.png")).toBe("x.png");
    expect(destKey("a", "/photos/", "x.png")).toBe("photos/x.png");
  });
  it("throws INVALID_PATH outside the bucket or on non-files", () => {
    expect(errorCode(() => destKey("", "../x", "n"))).toBe("INVALID_PATH");
    expect(errorCode(() => destKey("a", "../../x", "n"))).toBe("INVALID_PATH");
    expect(errorCode(() => destKey("a", "..", "n"))).toBe("INVALID_PATH");
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
