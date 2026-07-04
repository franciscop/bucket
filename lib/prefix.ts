// Folder support: a folder is a bucket scoped to a key prefix. `bucket.folder()`
// returns a copy of the bucket with its PREFIX set; these helpers combine that
// prefix with child paths and list filters. When PREFIX is "" every helper is a
// no-op, so an unscoped bucket behaves exactly as it did before folders existed.

// Normalize a folder path to a bare prefix: no leading "./" or "/", no trailing
// "/", collapsed inner slashes. "" means the bucket root.
export const cleanPrefix = (p: string): string =>
  p
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\/+/g, "/");

// Full key for a child `name` inside `prefix` (prefix already clean).
export const withPrefix = (prefix: string, name: string): string =>
  prefix ? `${prefix}/${name}` : name;

// Prefix for a nested folder: the parent prefix plus a freshly-cleaned path.
export const joinPrefix = (parent: string, path: string): string =>
  withPrefix(parent, cleanPrefix(path));

// Translate a caller's filter into what a provider `list()` needs: `query` is the
// string prefix to send to the provider, and `test(key)` re-checks each returned
// full key so results never leak outside the folder. For a RegExp the match is
// folder-relative (tested against the path below the folder). `test` alone is
// sufficient (providers without server-side prefixing can rely on it).
export function scope(
  prefix: string,
  filter?: string | RegExp,
): { query: string; test: (key: string) => boolean } {
  const dir = prefix ? prefix + "/" : "";
  if (filter instanceof RegExp) {
    return {
      query: dir,
      test: (key) => key.startsWith(dir) && filter.test(key.slice(dir.length)),
    };
  }
  const query = dir + (filter ?? "");
  return { query, test: (key) => key.startsWith(query) };
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
  clone.PREFIX = joinPrefix(bucket.PREFIX, path);
  return clone;
}
