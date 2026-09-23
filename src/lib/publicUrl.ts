// Each segment in full, so "a#b.png" never turns into a fragment.
export function encodePublicPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Joins a configured public origin with a bucket-relative path. */
export function publicUrlFrom(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${encodePublicPath(path)}`;
}
