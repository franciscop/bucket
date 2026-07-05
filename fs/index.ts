import { userInfo } from "node:os";
import fsp from "node:fs/promises";
import { basename, join, resolve, isAbsolute, relative } from "node:path";

import type { Bucket, BucketInfo } from "../lib/types.ts";
import { cleanPrefix } from "../lib/prefix.ts";
import { FSFile } from "./File.ts";

class FileSystemBucket implements Bucket {
  readonly type = "FILESYSTEM";
  path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  info(): Promise<BucketInfo> {
    return Promise.resolve({
      type: this.type,
      name: basename(this.path) || this.path,
      url: this.path,
      id: userInfo().username,
    });
  }

  async list(filter?: RegExp): Promise<FSFile[]> {
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
      .map((f: import("node:fs").Dirent) =>
        this.file(
          join(
            (f as unknown as { parentPath: string }).parentPath ??
              (f as unknown as { path: string }).path,
            f.name,
          ),
        ),
      );
    const result = filter
      ? files.filter((f: FSFile) => filter.test(relative(this.path, f.path)))
      : files;
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  file(name: string): FSFile {
    if (!name) throw new Error("No name");
    const path = resolve(isAbsolute(name) ? name : join(this.path, name));
    return new FSFile(path, this.path);
  }

  folder(path: string): FileSystemBucket {
    return new FileSystemBucket(join(this.path, cleanPrefix(path)));
  }

  async remove(filter?: RegExp): Promise<FSFile[]> {
    const files = await this.list(filter);
    await Promise.all(files.map((f) => f.remove()));
    return files;
  }

  async count(filter?: RegExp): Promise<number> {
    return (await this.list(filter)).length;
  }

  async *scan(filter?: RegExp): AsyncGenerator<FSFile> {
    // The filesystem has no pagination; readdir already returns everything.
    for (const file of await this.list(filter)) yield file;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<FSFile> {
    yield* this.scan();
  }
}

/**
 * Create a local filesystem bucket handle.
 *
 * All file paths are resolved relative to `path`.
 * Nested directories are created automatically on write.
 *
 * @param path - Root directory for all file operations
 *
 * @example
 * const bucket = FileSystem("./uploads");
 * await bucket.file("hello.txt").write("hello");
 */
export default function FileSystem(path: string): FileSystemBucket {
  return new FileSystemBucket(path);
}

export type {
  Bucket,
  BucketFile,
  FileInfo,
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
