// Byte-range support for file.slice(). `end` is exclusive (like Blob.slice);
// undefined means "to EOF". Ranges compose: slicing a slice offsets into the
// parent. Reads translate a range to an HTTP `Range` header (remote backends)
// or to positional reads (filesystem); info() reports the clamped slice length.

export interface ByteRange {
  start: number;
  end?: number; // exclusive; undefined = to end of file
}

// Combine a parent range with a child slice(start, end?). Non-negative only.
export function composeRange(
  base: ByteRange | null,
  start: number,
  end?: number,
): ByteRange {
  const baseStart = base?.start ?? 0;
  const baseEnd = base?.end;
  const s = baseStart + Math.max(0, start);
  let e: number | undefined;
  if (end === undefined) {
    e = baseEnd;
  } else {
    e = baseStart + Math.max(0, end);
    if (baseEnd !== undefined) e = Math.min(e, baseEnd);
  }
  if (e !== undefined && e < s) e = s; // never negative length
  return e === undefined ? { start: s } : { start: s, end: e };
}

// A range that resolves to zero bytes (nothing to read).
export function isEmptyRange(range: ByteRange): boolean {
  return range.end !== undefined && range.end <= range.start;
}

// The HTTP `Range` header value, or null when the range is empty (the caller
// should return an empty read without issuing a request).
export function rangeHeader(range: ByteRange): string | null {
  if (isEmptyRange(range)) return null;
  const last = range.end !== undefined ? range.end - 1 : "";
  return `bytes=${range.start}-${last}`;
}

// The clamped byte length of a range given the object's full size.
export function rangeSize(range: ByteRange | null, total: number): number {
  if (!range) return total;
  const from = Math.min(range.start, total);
  const to = range.end === undefined ? total : Math.min(range.end, total);
  return Math.max(0, to - from);
}
