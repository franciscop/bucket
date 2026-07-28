import { Blob } from "node:buffer";
import { createReadStream, createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { WritableStream } from "node:stream/web";

import { getContentType } from "../lib/fileTypes.ts";
import BucketError from "../lib/BucketError.ts";
import { destKey } from "../lib/prefix.ts";
import {
  composeRange,
  isEmptyRange,
  rangeSize,
  type ByteRange,
} from "../lib/range.ts";
import type {
  BucketFile,
  FileInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";

// Map a Node filesystem error to a BucketError so `.code` is uniform with the
// remote providers (ENOENT → NOT_FOUND, permission → FORBIDDEN).
function fsError(err: unknown): never {
  const code = (err as NodeJS.ErrnoException).code;
  throw new BucketError((err as Error).message, {
    provider: "FILESYSTEM",
    code:
      code === "ENOENT"
        ? "NOT_FOUND"
        : code === "EACCES" || code === "EPERM"
          ? "FORBIDDEN"
          : "UNKNOWN",
    cause: err,
  });
}

export class FSFile implements BucketFile {
  name: string;
  // Path within the bucket, like the remote providers. The OS location is
  // private (#abs); derive it externally with join(root, file.path).
  path: string;
  #root: string;
  #prefix: string;
  #abs: string;
  #range: ByteRange | null = null;

  constructor(key: string, root: string, prefix: string) {
    this.name = key.split("/").pop()!;
    this.path = key;
    this.#root = root;
    this.#prefix = prefix;
    this.#abs = join(root, key);
  }

  slice(start: number, end?: number): FSFile {
    const f = new FSFile(this.path, this.#root, this.#prefix);
    f.#range = composeRange(this.#range, start, end);
    return f;
  }

  async info(): Promise<FileInfo | null> {
    let stat: { size: number; mtime: Date };
    try {
      stat = await fsp.stat(this.#abs);
    } catch {
      return null;
    }
    return {
      size: rangeSize(this.#range, stat.size),
      type: getContentType(this.path) ?? null,
      modified: new Date(stat.mtime),
      version: null,
      metadata: {},
    };
  }

  async exists(): Promise<boolean> {
    return fsp
      .access(this.#abs, fsp.constants.F_OK)
      .then(() => true)
      .catch(() => false);
  }

  async #read() {
    if (!this.#range) return fsp.readFile(this.#abs).catch(fsError);
    if (isEmptyRange(this.#range)) return Buffer.alloc(0);
    const { start, end } = this.#range;
    const fh = await fsp.open(this.#abs).catch(fsError);
    try {
      const size = (await fh.stat()).size;
      const from = Math.min(start, size);
      const to = end === undefined ? size : Math.min(end, size);
      const len = Math.max(0, to - from);
      const buf = Buffer.alloc(len);
      if (len > 0) await fh.read(buf, 0, len, from);
      return buf;
    } finally {
      await fh.close();
    }
  }

  async text(): Promise<string> {
    return (await this.#read()).toString("utf-8");
  }

  async json(): Promise<unknown> {
    return JSON.parse((await this.#read()).toString("utf-8"));
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const buf = await this.#read();
    return buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
  }

  async blob(): Promise<Blob> {
    // Carry a content-type (from the extension) so the Blob round-trips through
    // FormData / Response with the right type, like the remote providers do.
    const type = getContentType(this.path);
    return new Blob([await this.#read()], type ? { type } : {});
  }

  async bytes(): Promise<Uint8Array> {
    return new Uint8Array(await this.arrayBuffer());
  }

  async write(content: WriteContent, _options?: WriteOptions): Promise<void> {
    if (typeof content === "string") {
      await fsp.mkdir(dirname(this.#abs), { recursive: true });
      return fsp.writeFile(this.#abs, content);
    }
    if (content instanceof Buffer || content instanceof Uint8Array) {
      await fsp.mkdir(dirname(this.#abs), { recursive: true });
      return fsp.writeFile(this.#abs, content);
    }
    if (content instanceof Blob) {
      await fsp.mkdir(dirname(this.#abs), { recursive: true });
      return fsp.writeFile(this.#abs, Buffer.from(await content.arrayBuffer()));
    }
    if (content instanceof FSFile) {
      return content.stream().pipeTo(this.writable());
    }
    if (typeof (content as { pipeTo?: unknown }).pipeTo === "function") {
      return (content as ReadableStream<Uint8Array>).pipeTo(this.writable());
    }
    if (content instanceof Readable) {
      return (
        Readable.toWeb(content) as unknown as ReadableStream<Uint8Array>
      ).pipeTo(this.writable());
    }
    throw new Error("Invalid content type");
  }

  async copyTo(dest: string | BucketFile): Promise<void> {
    if (typeof dest !== "string") {
      await dest.write(this);
      return;
    }
    const dst = join(this.#root, destKey(this.#prefix, dest, this.name));
    await fsp.mkdir(dirname(dst), { recursive: true });
    await fsp.copyFile(this.#abs, dst).catch(fsError);
  }

  async moveTo(dest: string | BucketFile): Promise<void> {
    if (typeof dest !== "string") {
      await dest.write(this);
      await this.remove();
      return;
    }
    const dst = join(this.#root, destKey(this.#prefix, dest, this.name));
    await fsp.mkdir(dirname(dst), { recursive: true });
    await fsp.rename(this.#abs, dst).catch(fsError);
  }

  async rename(name: string): Promise<void> {
    if (!name || name === "." || name === "..")
      throw new Error(`rename() needs a file name, got "${name}"`);
    if (name.includes("/"))
      throw new Error("rename() cannot change directory, use moveTo() instead");
    const rel = this.#prefix
      ? this.path.slice(this.#prefix.length + 1)
      : this.path;
    const dir = rel.split("/").slice(0, -1).join("/");
    await this.moveTo(dir ? dir + "/" + name : name);
  }

  async remove(): Promise<void> {
    return fsp.unlink(this.#abs);
  }

  // Bun-style aliases, so muscle memory from Bun's S3File carries over
  unlink(): Promise<void> {
    return this.remove();
  }

  async publicUrl(): Promise<null> {
    return null;
  }

  async signedUrl(_opts: { expires: number | string }): Promise<null> {
    return null;
  }

  async uploadUrl(_opts: { expires: number | string }): Promise<null> {
    return null;
  }

  stream(): ReadableStream {
    return Readable.toWeb(this.nodeReadable()) as unknown as ReadableStream;
  }

  nodeReadable(): NodeJS.ReadableStream {
    if (!this.#range) return createReadStream(this.#abs);
    if (isEmptyRange(this.#range)) return Readable.from([]);
    const { start, end } = this.#range;
    // Node's `end` is inclusive; our range end is exclusive.
    return createReadStream(this.#abs, {
      start,
      ...(end !== undefined ? { end: end - 1 } : {}),
    });
  }

  nodeWritable(_options?: WriteOptions): NodeJS.WritableStream {
    return Writable.fromWeb(this.writable() as WritableStream<Uint8Array>);
  }

  writable(_options?: WriteOptions): WritableStream {
    const filePath = this.#abs;
    let writer: ReturnType<typeof createWriteStream> | null = null;

    return new WritableStream<Uint8Array>({
      async start() {
        await fsp.mkdir(dirname(filePath), { recursive: true });
        writer = createWriteStream(filePath);
        await new Promise<void>((resolve) => writer!.on("open", resolve));
      },
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          const ok = writer!.write(chunk);
          if (ok) resolve();
          else writer!.once("drain", resolve);
          writer!.once("error", reject);
        });
      },
      close() {
        return new Promise<void>((resolve, reject) => {
          writer!.end((err?: Error | null) => (err ? reject(err) : resolve()));
        });
      },
    });
  }
}
