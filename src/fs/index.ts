import { userInfo } from "node:os";
import fsp from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import { scope } from "../lib/prefix.ts";
import { throwIfAborted, type ReadOptions } from "../lib/abort.ts";
import { BaseBucket } from "../lib/base.ts";
import type { BucketInfo } from "../lib/types.ts";
import assertNotOsPath from "./osPathGuard.ts";
import { FSFile, type FSContext } from "./File.ts";

const { FS_PUBLIC_URL: ENV_PUBLIC_URL } = process.env;

export interface FSConfig {
  /** Public origin the directory is served from, e.g. a static mount like
   * `http://localhost:3000/static` (falls back to `FS_PUBLIC_URL`). Used by
   * `file.publicUrl()`, which returns null without it. */
  publicUrl?: string;
}

class FileSystemBucket extends BaseBucket<FSContext, FSFile> {
  readonly type = "FILESYSTEM";

  // OS directory of the current scope (the root plus the folder prefix).
  get path(): string {
    return join(this.ctx.root, this.PREFIX);
  }

  protected make(key: string): FSFile {
    return new FSFile(key, this.ctx);
  }

  file(name: string): FSFile {
    assertNotOsPath(this.ctx.root, name);
    return super.file(name);
  }

  folder(path: string): this {
    assertNotOsPath(this.ctx.root, path);
    return super.folder(path);
  }

  async info(opts?: ReadOptions): Promise<BucketInfo> {
    throwIfAborted(opts?.signal);
    return {
      type: this.type,
      name: basename(this.path) || this.path,
      url: this.path,
      id: userInfo().username,
    };
  }

  // The filesystem has no pagination: readdir returns everything at once.
  protected async *pages(filter?: RegExp) {
    const s = scope(this.PREFIX, filter);
    let raw: import("node:fs").Dirent[];
    try {
      raw = await fsp.readdir(this.path, {
        recursive: true,
        withFileTypes: true,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    yield raw
      .filter((d) => d.isFile())
      .map((d) => {
        const dir =
          (d as unknown as { parentPath?: string }).parentPath ??
          (d as unknown as { path: string }).path;
        const rel = relative(this.path, join(dir, d.name)).split(sep).join("/");
        return this.PREFIX ? `${this.PREFIX}/${rel}` : rel;
      })
      // Skip in-progress streaming writes (temp siblings, renamed on close)
      .filter((key) => !/\.tmp-[a-z0-9]+$/.test(key) && s.test(key))
      .sort((a, b) => a.localeCompare(b))
      .map((key) => this.make(key));
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
  config: FSConfig = {},
): FileSystemBucket {
  return new FileSystemBucket({
    provider: "FILESYSTEM",
    prefix: "",
    publicUrl: (config.publicUrl ?? ENV_PUBLIC_URL ?? "").replace(/\/+$/, ""),
    root: resolve(path),
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
