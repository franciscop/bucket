// Every provider is told the same four things on a write (type, cacheControl,
// disposition, metadata) and each spells them differently on the wire. Resolve
// them once into a normalized shape, then let each provider name its own keys.
import BucketError from "./BucketError.ts";
import { resolveContentType } from "./contentType.ts";
import type { WriteOptions } from "./types.ts";

export interface WriteMeta {
  /** Resolved MIME type, or null when the extension is unknown. */
  type: string | null;
  cacheControl?: string;
  disposition?: string;
  /** Custom metadata, keys lowercased: every provider sends them as headers,
   * which are case-insensitive, so the casing would not survive a round trip. */
  metadata: Record<string, string>;
}

export function writeMeta(
  path: string,
  options: WriteOptions = {},
  content?: Blob,
): WriteMeta {
  return {
    type: resolveContentType(path, content, options) ?? null,
    cacheControl: options.cacheControl,
    disposition: options.disposition,
    metadata: Object.fromEntries(
      Object.entries(options.metadata ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    ),
  };
}

/** What a provider calls each field. Omit a key to leave that field out. */
export interface MetaNames {
  /** Label for the error when a value cannot travel as a header. */
  provider: string;
  type?: string;
  cacheControl?: string;
  disposition?: string;
  /** Prefix for custom metadata keys; "" keeps them bare. */
  metaPrefix?: string;
}

// Printable ASCII only: fetch() rejects anything past Latin-1, providers
// mangle the rest, and a newline would inject a header.
const HEADER_SAFE = /^[\x20-\x7e]*$/;

function assertHeaderSafe(field: string, value: string, provider: string) {
  if (HEADER_SAFE.test(value)) return;
  throw new BucketError(
    `${provider} sends ${field} as an HTTP header, which must be printable ASCII; got ${JSON.stringify(value)}. Encode it first, e.g. with encodeURIComponent().`,
    { code: "INVALID_CONTENT" },
  );
}

/** Renders the normalized metadata under a provider's own key names. */
export function metaHeaders(
  meta: WriteMeta,
  names: MetaNames,
): Record<string, string> {
  const { provider } = names;
  if (meta.cacheControl)
    assertHeaderSafe("cacheControl", meta.cacheControl, provider);
  if (meta.disposition)
    assertHeaderSafe("disposition", meta.disposition, provider);
  for (const [k, v] of Object.entries(meta.metadata)) {
    assertHeaderSafe(`metadata key ${JSON.stringify(k)}`, k, provider);
    assertHeaderSafe(`metadata ${JSON.stringify(k)}`, v, provider);
  }
  const out: Record<string, string> = {};
  if (names.type && meta.type) out[names.type] = meta.type;
  if (names.cacheControl && meta.cacheControl)
    out[names.cacheControl] = meta.cacheControl;
  if (names.disposition && meta.disposition)
    out[names.disposition] = meta.disposition;
  if (names.metaPrefix !== undefined)
    for (const [k, v] of Object.entries(meta.metadata))
      out[names.metaPrefix + k] = v;
  return out;
}
