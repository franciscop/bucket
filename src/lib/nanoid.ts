import { getExtension } from "./fileTypes.ts";
import type { WriteContent, WriteOptions } from "./types.ts";

// nanoid, inlined to stay dependency-free, over a strictly alphanumeric
// alphabet so ids are safe anywhere (urls, shells, file names).
const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export default function nanoid(size = 21): string {
  let id = "";
  while (id.length < size) {
    // 248 is the largest multiple of 62: discarding the rest keeps every
    // character equally likely, which a plain `% 62` would not.
    for (const byte of crypto.getRandomValues(new Uint8Array(size))) {
      if (byte < 248 && id.length < size) id += ALPHABET[byte % 62];
    }
  }
  return id;
}

// The extension comes from an explicit `type` option, or else from a name the
// body carries (a File, or another BucketFile). Anything else would be
// guesswork, so the name stays bare.
export function randomName(
  content: WriteContent,
  options?: WriteOptions,
): string {
  if (options?.type) {
    const ext = getExtension(options.type);
    if (ext) return nanoid() + ext;
  }
  const named = content as { name?: unknown };
  const source = typeof named?.name === "string" ? named.name : "";
  const dot = source.lastIndexOf(".");
  const ext = dot > 0 ? source.slice(dot) : "";
  return nanoid() + (/^\.[a-zA-Z0-9]{1,12}$/.test(ext) ? ext : "");
}
