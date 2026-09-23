// Byte helpers over plain Uint8Array, so the library runs without Node's Buffer.
const encoder = new TextEncoder();

/** A string as UTF-8 bytes; bytes pass through unchanged. */
export const toBytes = (data: string | Uint8Array): Uint8Array =>
  typeof data === "string" ? encoder.encode(data) : data;

/** One Uint8Array holding every chunk in order. */
export function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
