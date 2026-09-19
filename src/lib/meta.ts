// Extract custom metadata from response headers carrying the given prefix
// (S3/R2 `x-amz-meta-*`, Azure `x-ms-meta-*`, B2 `x-bz-info-*`). Header names
// arrive lowercased, and we write keys lowercased, so metadata round-trips with
// lowercase keys. `skip` filters provider-internal entries (e.g. B2's `b2-*`).
export default function metaFromHeaders(
  headers: Headers,
  prefix: string,
  skip?: (key: string) => boolean,
): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const [key, value] of headers) {
    if (!key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length);
    if (skip?.(name)) continue;
    meta[name] = value;
  }
  return meta;
}
