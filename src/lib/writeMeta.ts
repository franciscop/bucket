// Every provider is told the same four things on a write (type, cacheControl,
// disposition, metadata) and each spells them differently on the wire. Resolve
// them once into a normalized shape, then let each provider name its own keys.
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
  type?: string;
  cacheControl?: string;
  disposition?: string;
  /** Prefix for custom metadata keys; "" keeps them bare. */
  metaPrefix?: string;
}

/** Renders the normalized metadata under a provider's own key names. */
export function metaHeaders(
  meta: WriteMeta,
  names: MetaNames,
): Record<string, string> {
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
