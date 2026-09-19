import BucketError from "../lib/BucketError.ts";
import { fileKey, folderKey, scope } from "../lib/prefix.ts";
import { randomName } from "../lib/nanoid.ts";
import { assertFilter, requireFilter } from "../lib/filter.ts";
import { throwIfAborted, type ReadOptions } from "../lib/abort.ts";
import type {
  Bucket,
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
import { MemoryFile, type MemoryEntry, type MemoryStore } from "./File.ts";

const { MEMORY_PUBLIC_URL: ENV_PUBLIC_URL } = process.env;

export interface MemoryConfig {
  /** Public origin to pretend the bucket is served from (falls back to
   * `MEMORY_PUBLIC_URL`). Used by `file.publicUrl()`, which returns null
   * without it. Nothing actually serves these bytes. */
  publicUrl?: string;
}

class MemoryBucket implements Bucket {
  readonly type = "MEMORY";
  #name: string;
  // The one Map behind this bucket. folder() shares it; a second Memory() call
  // gets its own, which is what makes instances isolated.
  #files: Map<string, MemoryEntry>;
  #publicUrl: string;
  PREFIX: string;

  constructor(
    name: string = "memory",
    config: MemoryConfig = {},
    files: Map<string, MemoryEntry> = new Map(),
    prefix = "",
  ) {
    if (!name) {
      throw new BucketError("Memory needs a bucket name.", {
        code: "INVALID_CONFIG",
      });
    }
    this.#name = name;
    this.#files = files;
    this.#publicUrl = (config.publicUrl ?? ENV_PUBLIC_URL ?? "").replace(
      /\/+$/,
      "",
    );
    this.PREFIX = prefix;
  }

  #store(): MemoryStore {
    return {
      files: this.#files,
      publicUrl: this.#publicUrl,
      prefix: this.PREFIX,
    };
  }

  async info(opts?: ReadOptions): Promise<BucketInfo> {
    throwIfAborted(opts?.signal);
    return {
      type: this.type,
      name: this.PREFIX ? `${this.#name}/${this.PREFIX}` : this.#name,
      url: `memory://${this.#name}${this.PREFIX ? "/" + this.PREFIX : ""}`,
      id: this.#name,
    };
  }

  file(name: string): MemoryFile {
    if (!name) throw new Error("No name");
    return new MemoryFile(fileKey(this.PREFIX, name), this.#store());
  }

  async create(
    content: WriteContent,
    options?: WriteOptions,
  ): Promise<MemoryFile> {
    throwIfAborted(options?.signal);
    return this.file(randomName(content, options)).write(content, options);
  }

  folder(path: string): MemoryBucket {
    // Shares the same Map: a folder is a view, not a copy.
    return new MemoryBucket(
      this.#name,
      { publicUrl: this.#publicUrl },
      this.#files,
      folderKey(this.PREFIX, path),
    );
  }

  async list(filter?: RegExp, opts?: ReadOptions): Promise<MemoryFile[]> {
    assertFilter(filter);
    throwIfAborted(opts?.signal);
    const s = scope(this.PREFIX, filter);
    const store = this.#store();
    return [...this.#files.keys()]
      .filter((key) => s.test(key))
      .sort((a, b) => a.localeCompare(b))
      .map((key) => new MemoryFile(key, store));
  }

  scan(filter?: RegExp, opts?: ReadOptions): AsyncGenerator<MemoryFile> {
    assertFilter(filter);
    // Eager, like the filter check: an aborted scan must not wait for the
    // first iteration to reject.
    throwIfAborted(opts?.signal);
    return this.#scan(filter, opts);
  }

  async *#scan(
    filter?: RegExp,
    opts?: ReadOptions,
  ): AsyncGenerator<MemoryFile> {
    for (const file of await this.list(filter, opts)) {
      throwIfAborted(opts?.signal);
      yield file;
    }
  }

  async remove(filter: RegExp, opts?: ReadOptions): Promise<MemoryFile[]> {
    requireFilter(filter);
    throwIfAborted(opts?.signal);
    const files = await this.list(filter, opts);
    for (const file of files) await file.remove(opts);
    return files;
  }

  async count(filter?: RegExp, opts?: ReadOptions): Promise<number> {
    assertFilter(filter);
    return (await this.list(filter, opts)).length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<MemoryFile> {
    yield* this.scan();
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
  name?: string,
  config?: MemoryConfig,
): MemoryBucket {
  return new MemoryBucket(name, config);
}

export type {
  Bucket,
  BucketFile,
  FileInfo,
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
