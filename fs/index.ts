import { userInfo } from "node:os";
import fsp from "node:fs/promises";
import { basename, join, resolve, isAbsolute } from "node:path";

import type { IBucket, BucketInfo } from "../lib/types.ts";
import { FSFile } from "./File.ts";

class FileSystemBucket implements IBucket {
  readonly type = "FILESYSTEM";
  path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  info(): Promise<BucketInfo> {
    return Promise.resolve({
      type: this.type,
      name: basename(this.path) || this.path,
      endpoint: this.path,
      id: userInfo().username,
    });
  }

  async list(filter?: RegExp | string): Promise<FSFile[]> {
    const raw = await fsp.readdir(this.path, {
      recursive: true,
      withFileTypes: true,
    });
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
    const result =
      filter instanceof RegExp
        ? files.filter((f: FSFile) => filter.test(f.name))
        : files;
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  file(name: string): FSFile {
    if (!name) throw new Error("No name");
    const path = resolve(isAbsolute(name) ? name : join(this.path, name));
    return new FSFile(path, this.path);
  }

  async remove(filter?: RegExp | string): Promise<FSFile[]> {
    const files = await this.list(filter);
    await Promise.all(files.map((f) => f.remove()));
    return files;
  }

  async count(filter?: RegExp | string): Promise<number> {
    return (await this.list(filter)).length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<FSFile> {
    for (const file of await this.list()) {
      yield file;
    }
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

export { FileSystemBucket, FSFile };

export type {
  FileInfo,
  BucketInfo,
  FileEntry,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
