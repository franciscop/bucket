// Folder support: a folder is a bucket scoped to a key prefix. `bucket.folder()`
// returns a copy of the bucket with its PREFIX set; these helpers resolve every
// user-supplied path against that prefix and validate it. Paths share one
// syntax on every provider, including the filesystem: "/" separates segments,
// "." and ".." are applied, and a leading "/" anchors at the bucket root.

import BucketError from "./BucketError.ts";

const invalid = (path: string): never => {
  throw new BucketError(`Invalid path: "${path}"`, { code: "INVALID_PATH" });
};

// Resolve a path expression against a folder prefix. Returns a bare key, where
// "" is the bucket root. Throws INVALID_PATH when ".." climbs above the bucket
// root, and on backslashes (URL parsers treat "\" as "/", so "..\" would be a
// hidden traversal on path-style endpoints).
export const resolvePath = (base: string, path: string): string => {
  if (path.includes("\\")) invalid(path);
  const out = !path.startsWith("/") && base ? base.split("/") : [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!out.length)
        throw new BucketError(`Path escapes the bucket: "${path}"`, {
          code: "INVALID_PATH",
        });
      out.pop();
    } else out.push(segment);
  }
  return out.join("/");
};

// Key for `bucket.file(name)`: any path syntax is allowed, but the resolved
// result must name a file inside the bucket/folder it is called on. file() is
// where untrusted strings arrive, so containment is checked on the result.
export const fileKey = (prefix: string, name: string): string => {
  const key = resolvePath(prefix, name);
  if (!key || (prefix && !key.startsWith(prefix + "/"))) invalid(name);
  return key;
};

// Prefix for `bucket.folder(path)`: pure navigation. "../" climbs to the
// parent folder, a leading "/" anchors at the bucket root, and only the bucket
// root itself is impassable. "" means the bucket root.
export const folderKey = resolvePath;

// Key for a copyTo()/moveTo() string destination: navigates like folder(),
// and a trailing "/" means "into that folder, keeping the file name".
export const destKey = (prefix: string, dest: string, name: string): string => {
  const key = resolvePath(prefix, dest.endsWith("/") ? dest + name : dest);
  if (!key) invalid(dest);
  return key;
};

// Translate the current folder plus an optional RegExp into what a provider
// `list()` needs: `query` is the folder prefix to send to the provider, and
// `test(key)` re-checks each returned full key so results never leak outside the
// folder. The RegExp is matched folder-relative (against the path below the
// folder). `test` alone is sufficient, so providers without server-side
// prefixing (the filesystem) can rely on it.
export function scope(
  prefix: string,
  filter?: RegExp,
): { query: string; test: (key: string) => boolean } {
  const dir = prefix ? prefix + "/" : "";
  return {
    query: dir,
    test: (key) =>
      key.startsWith(dir) && (!filter || filter.test(key.slice(dir.length))),
  };
}

// Copy a bucket instance and set a new PREFIX. Works for backends whose state is
// all in normal (non-#private) fields, so `Object.assign` copies it and no
// constructor re-runs (important for providers that authenticate on construction).
export function subBucket<T extends { PREFIX: string }>(
  bucket: T,
  path: string,
): T {
  const clone = Object.assign(
    Object.create(Object.getPrototypeOf(bucket)),
    bucket,
  );
  clone.PREFIX = folderKey(bucket.PREFIX, path);
  return clone;
}
