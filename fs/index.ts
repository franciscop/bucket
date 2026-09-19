import { userInfo } from "node:os";
import fsp from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import type {
  Bucket,
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
import { fileKey, folderKey } from "../lib/prefix.ts";
import { randomName } from "../lib/nanoid.ts";
import { assertFilter, requireFilter } from "../lib/filter.ts";
import { throwIfAborted, type ReadOptions } from "../lib/abort.ts";
import assertNotOsPath from "./osPathGuard.ts";
import { FSFile } from "./File.ts";

const { FS_PUBLIC_URL: ENV_PUBLIC_URL } = process.env;

export interface FSConfig {
  /** Public origin the directory is served from, e.g. a static mount like
   * `http://localhost:3000/static` (falls back to `FS_PUBLIC_URL`). Used by
   * `file.publicUrl()`, which returns null without it. */
  publicUrl?: string;
}

class FileSystemBucket implements Bucket {
  readonly type = "FILESYSTEM";
  // OS directory the bucket was created with: the containment boundary.
  // Nothing ever resolves outside it. Folder scoping is a key PREFIX below
  // it, exactly like the remote providers.
  #root: string;
  #publicUrl: string;
  PREFIX: string;

  constructor(path: string, config: FSConfig = {}, prefix = "") {
    this.#root = resolve(path);
    this.#publicUrl = (config.publicUrl ?? ENV_PUBLIC_URL ?? "").replace(
      /\/+$/,
      "",
    );
    this.PREFIX = prefix;
  }

  // OS directory of the current scope (the root plus the folder prefix).
  get path(): string {
    return join(this.#root, this.PREFIX);
  }

  info(opts?: ReadOptions): Promise<BucketInfo> {
    throwIfAborted(opts?.signal);
    return Promise.resolve({
      type: this.type,
      name: basename(this.path) || this.path,
      url: this.path,
      id: userInfo().username,
    });
  }

  async list(filter?: RegExp, opts?: ReadOptions): Promise<FSFile[]> {
    assertFilter(filter);
    throwIfAborted(opts?.signal);
    let raw: import("node:fs").Dirent[];
    try {
      raw = await fsp.readdir(this.path, {
        recursive: true,
        withFileTypes: true,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const files = raw
      .filter((dirent: import("node:fs").Dirent) => dirent.isFile())
      .map((f: import("node:fs").Dirent) => {
        const abs = join(
          (f as unknown as { parentPath: string }).parentPath ??
            (f as unknown as { path: string }).path,
          f.name,
        );
        return relative(this.path, abs).split(sep).join("/");
      })
      // Skip in-progress streaming writes (temp siblings, renamed on close)
      .filter((rel: string) => !/\.tmp-[a-z0-9]+$/.test(rel))
      .filter((rel: string) => !filter || filter.test(rel))
      .map(
        (rel: string) =>
          new FSFile(
            this.PREFIX ? `${this.PREFIX}/${rel}` : rel,
            this.#root,
            this.PREFIX,
            this.#publicUrl,
          ),
      );
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  file(name: string): FSFile {
    if (!name) throw new Error("No name");
    assertNotOsPath(this.#root, name);
    return new FSFile(
      fileKey(this.PREFIX, name),
      this.#root,
      this.PREFIX,
      this.#publicUrl,
    );
  }

  async create(content: WriteContent, options?: WriteOptions): Promise<FSFile> {
    throwIfAborted(options?.signal);
    return this.file(randomName(content, options)).write(content, options);
  }

  folder(path: string): FileSystemBucket {
    assertNotOsPath(this.#root, path);
    return new FileSystemBucket(
      this.#root,
      { publicUrl: this.#publicUrl },
      folderKey(this.PREFIX, path),
    );
  }

  async remove(filter: RegExp, opts?: ReadOptions): Promise<FSFile[]> {
    requireFilter(filter);
    throwIfAborted(opts?.signal);
    const files = await this.list(filter, opts);
    await Promise.all(files.map((f) => f.remove(opts)));
    return files;
  }

  async count(filter?: RegExp, opts?: ReadOptions): Promise<number> {
    assertFilter(filter);
    return (await this.list(filter, opts)).length;
  }

  scan(filter?: RegExp, opts?: ReadOptions): AsyncGenerator<FSFile> {
    assertFilter(filter);
    // Eager, like the filter check: an aborted scan must not wait for the
    // first iteration to reject.
    throwIfAborted(opts?.signal);
    return this.#scan(filter, opts);
  }

  async *#scan(filter?: RegExp, opts?: ReadOptions): AsyncGenerator<FSFile> {
    // The filesystem has no pagination; readdir already returns everything.
    for (const file of await this.list(filter, opts)) {
      throwIfAborted(opts?.signal);
      yield file;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<FSFile> {
    yield* this.scan();
  }
}

/**
 * Create a local filesystem bucket handle.
 *
 * All paths are relative to `path`, exactly like the remote providers: a
 * leading "/" means the bucket root (never the filesystem root), and nothing
 * ever resolves outside `path`; escapes throw a BucketError with code
 * "INVALID_PATH". `file.path` is the path within the bucket; the OS location
 * is `join(path, file.path)`. Nested directories are created automatically
 * on write.
 *
 * @param path - Root directory for all file operations
 * @param config.publicUrl - Public origin for `file.publicUrl()` (falls back to `FS_PUBLIC_URL`)
 *
 * @example
 * const bucket = FileSystem("./uploads");
 * await bucket.file("hello.txt").write("hello");
 */
export default function FileSystem(
  path: string,
  config?: FSConfig,
): FileSystemBucket {
  return new FileSystemBucket(path, config);
}

export type {
  Bucket,
  BucketFile,
  FileInfo,
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
