// Tiny deterministic string -> unsigned 32-bit hash (FNV-1a). Replaces the
// `hash-it` dependency; only used to derive the FileSystem file `id`.
export default function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
