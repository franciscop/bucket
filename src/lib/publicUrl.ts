// Building a public URL is not the same problem as signing a request.
// encodeS3Path() and Azure's encodePath() deliberately encode only what would
// break a signature, and leave "#", "?", "+" and spaces to the WHATWG parser
// inside fetch(). publicUrl() returns a plain string that no parser will ever
// touch, so "a#b.png" would silently become a fragment. Encode each segment in
// full instead, keeping the "/" separators.
export function encodePublicPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Joins a configured public origin with a bucket-relative path. */
export function publicUrlFrom(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${encodePublicPath(path)}`;
}
