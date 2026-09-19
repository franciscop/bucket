import BucketError from "../lib/BucketError.ts";
import { scope } from "../lib/prefix.ts";
import { throwIfAborted, type ReadOptions } from "../lib/abort.ts";
import { BaseBucket } from "../lib/base.ts";
import type { BucketInfo } from "../lib/types.ts";
import { MemoryFile, type MemoryContext } from "./File.ts";

const { MEMORY_PUBLIC_URL: ENV_PUBLIC_URL } = process.env;

export interface MemoryConfig {
  /** Public origin to pretend the bucket is served from (falls back to
   * `MEMORY_PUBLIC_URL`). Used by `file.publicUrl()`, which returns null
   * without it. Nothing actually serves these bytes. */
  publicUrl?: string;
}

class MemoryBucket extends BaseBucket<MemoryContext, MemoryFile> {
  readonly type = "MEMORY";

  protected make(key: string): MemoryFile {
    return new MemoryFile(key, this.ctx);
  }

  async info(opts?: ReadOptions): Promise<BucketInfo> {
    throwIfAborted(opts?.signal);
    const scoped = this.PREFIX
      ? `${this.ctx.name}/${this.PREFIX}`
      : this.ctx.name;
    return {
      type: this.type,
      name: scoped,
      url: `memory://${scoped}`,
      id: this.ctx.name,
    };
  }

  protected async *pages(filter?: RegExp) {
    const s = scope(this.PREFIX, filter);
    yield [...this.ctx.files.keys()]
      .filter((key) => s.test(key))
      .sort((a, b) => a.localeCompare(b))
      .map((key) => this.make(key));
  }
}

/**
 * Create an in-memory bucket handle, backed by a Map.
 *
 * Built for tests: fast, no disk, nothing to clean up, and isolated per
 * instance (two `Memory()` calls are two separate buckets). The data dies with
 * the process. It is not a cache and not a scratch bucket; do not use it in
 * production.
 *
 * It is the one provider that ignores nothing a write is given: `type`,
 * `metadata`, `cacheControl` and `disposition` all round-trip through
 * `info()`, so it is the provider to develop against when you use metadata.
 *
 * @param name - Bucket name, only used by `info()` (default `"memory"`)
 * @param config.publicUrl - Public origin for `file.publicUrl()` (falls back to `MEMORY_PUBLIC_URL`)
 *
 * @example
 * const bucket = Memory();
 * await bucket.file("hello.txt").write("hello");
 */
export default function Memory(
  name = "memory",
  config: MemoryConfig = {},
): MemoryBucket {
  if (!name)
    throw new BucketError("Memory needs a bucket name.", {
      code: "INVALID_CONFIG",
    });
  return new MemoryBucket({
    provider: "MEMORY",
    prefix: "",
    publicUrl: (config.publicUrl ?? ENV_PUBLIC_URL ?? "").replace(/\/+$/, ""),
    // A folder shares this Map; a second Memory() call gets its own, which is
    // what makes instances isolated.
    files: new Map(),
    name,
  });
}

export type {
  Bucket,
  BucketFile,
  FileInfo,
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
