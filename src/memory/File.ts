import BucketError from "../lib/BucketError.ts";
import { throwIfAborted, type ReadOptions } from "../lib/abort.ts";
import { rangeSize } from "../lib/range.ts";
import { BaseFile, wholeBody, type FileContext } from "../lib/base.ts";
import type { FileInfo, WriteOptions } from "../lib/types.ts";

/** What the Map holds: the bytes plus everything write() was told about them. */
export interface MemoryEntry {
  data: Uint8Array;
  type: string | null;
  modified: Date;
  cacheControl?: string;
  disposition?: string;
  metadata: Record<string, string>;
}

export interface MemoryContext extends FileContext {
  /** The one Map behind the bucket, shared with every folder of it. */
  files: Map<string, MemoryEntry>;
  name: string;
}

export class MemoryFile extends BaseFile<MemoryContext> {
  #entry(): MemoryEntry {
    const entry = this.ctx.files.get(this.path);
    if (!entry) {
      throw new BucketError(`Memory file not found: ${this.path}`, {
        provider: this.provider,
        code: "NOT_FOUND",
      });
    }
    return entry;
  }

  // Wraps the bytes (the slice, when one is set) as a Response so the shared
  // readers work unchanged, carrying the stored content type.
  protected async fetch(): Promise<Response> {
    const entry = this.#entry();
    const data = this.range
      ? entry.data.subarray(this.range.start, this.range.end)
      : entry.data;
    return new Response(new Uint8Array(data), {
      headers: entry.type ? { "content-type": entry.type } : {},
    });
  }

  async info(opts?: ReadOptions): Promise<FileInfo | null> {
    throwIfAborted(opts?.signal);
    const entry = this.ctx.files.get(this.path);
    if (!entry) return null;
    return {
      size: rangeSize(this.range, entry.data.length),
      type: entry.type,
      modified: entry.modified,
      // Nothing is versioned here: remove() deletes.
      version: null,
      metadata: { ...entry.metadata },
      ...(entry.cacheControl ? { cacheControl: entry.cacheControl } : {}),
      ...(entry.disposition ? { disposition: entry.disposition } : {}),
    };
  }

  // The single place an entry is created, so every write path records the
  // same metadata: nothing a caller passes is dropped.
  protected async put(data: Uint8Array, options: WriteOptions): Promise<void> {
    this.ctx.files.set(this.path, {
      data,
      modified: new Date(),
      ...this.meta(options),
    });
  }

  // Committed only on close, so a reader never sees a partial write.
  protected target(options: WriteOptions) {
    return wholeBody((data) => this.put(data, options));
  }

  protected async copy(key: string): Promise<void> {
    const entry = this.#entry();
    // A copy of the bytes, not a shared reference: writing to one file must
    // never mutate the other.
    this.ctx.files.set(key, {
      ...entry,
      data: Uint8Array.from(entry.data),
      metadata: { ...entry.metadata },
      modified: new Date(),
    });
  }

  protected async delete(): Promise<void> {
    this.ctx.files.delete(this.path);
  }

  // Nothing serves these bytes, so there is no canonical URL to fall back on.
  protected async canonicalUrl() {
    return null;
  }

  // Nothing to sign: there is no endpoint behind an in-memory bucket.
  async signedUrl(_opts: { expires: number | string }): Promise<null> {
    return null;
  }

  async uploadUrl(_opts: { expires: number | string }): Promise<null> {
    return null;
  }
}
