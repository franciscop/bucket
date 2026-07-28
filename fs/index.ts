import { userInfo } from "node:os";
import fsp from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import type { Bucket, BucketInfo } from "../lib/types.ts";
import { fileKey, folderKey } from "../lib/prefix.ts";
import assertNotOsPath from "./osPathGuard.ts";
import { FSFile } from "./File.ts";

class FileSystemBucket implements Bucket {
  readonly type = "FILESYSTEM";
  // OS directory the bucket was created with: the containment boundary.
  // Nothing ever resolves outside it. Folder scoping is a key PREFIX below
  // it, exactly like the remote providers.
  #root: string;
  PREFIX: string;

  constructor(path: string, prefix = "") {
    this.#root = resolve(path);
    this.PREFIX = prefix;
  }

  // OS directory of the current scope (the root plus the folder prefix).
  get path(): string {
    return join(this.#root, this.PREFIX);
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
      .map((f: import("node:fs").Dirent) => {
        const abs = join(
          (f as unknown as { parentPath: string }).parentPath ??
            (f as unknown as { path: string }).path,
          f.name,
        );
        return relative(this.path, abs).split(sep).join("/");
      })
      .filter((rel: string) => !filter || filter.test(rel))
      .map(
        (rel: string) =>
          new FSFile(
            this.PREFIX ? `${this.PREFIX}/${rel}` : rel,
            this.#root,
            this.PREFIX,
          ),
      );
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  file(name: string): FSFile {
    if (!name) throw new Error("No name");
    assertNotOsPath(this.#root, name);
    return new FSFile(fileKey(this.PREFIX, name), this.#root, this.PREFIX);
  }

  folder(path: string): FileSystemBucket {
    assertNotOsPath(this.#root, path);
    return new FileSystemBucket(this.#root, folderKey(this.PREFIX, path));
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
 * All paths are relative to `path`, exactly like the remote providers: a
 * leading "/" means the bucket root (never the filesystem root), and nothing
 * ever resolves outside `path`; escapes throw a BucketError with code
 * "INVALID_PATH". `file.path` is the path within the bucket; the OS location
 * is `join(path, file.path)`. Nested directories are created automatically
 * on write.
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
