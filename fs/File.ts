import hash from "hash-it";

import { Blob } from "node:buffer";
import { exec } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
import { WritableStream } from "node:stream/web";
import { promisify } from "node:util";

import { getContentType } from "../lib/fileTypes.ts";
import type {
  IBucketFile,
  FileInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";

const execP = promisify(exec) as (
  cmd: string,
) => Promise<{ stdout: string; stderr: string }>;
const cmd = (txt: string): Promise<string> =>
  execP(txt).then((res) => res.stdout.trim());
const mimeType = (file: string): Promise<string> =>
  cmd(`file -b --mime-type '${file}'`);

export class FSFile implements IBucketFile {
  id: number;
  name: string;
  path: string;
  #root: string;

  constructor(path: string, root: string) {
    this.id = hash(path) as number;
    this.name = path.split("/").pop()!;
    this.path = path;
    this.#root = root;
  }

  async info(): Promise<FileInfo> {
    const [exists, info, type] = await Promise.all([
      this.exists(),
      fsp
        .stat(this.path)
        .catch(() => ({ size: 0, mtime: null as Date | null })),
      mimeType(this.path),
    ]);
    return {
      id: this.id,
      name: this.name,
      path: this.path,
      exists,
      type: exists ? type : null,
      size: (info as { size: number }).size,
      date: exists ? new Date((info as { mtime: Date }).mtime) : null,
      url: null,
    };
  }

  async exists(): Promise<boolean> {
    return fsp
      .access(this.path, fsp.constants.F_OK)
      .then(() => true)
      .catch(() => false);
  }

  async text(): Promise<string> {
    return fsp.readFile(this.path, "utf-8");
  }

  async json(): Promise<unknown> {
    return fsp
      .readFile(this.path, "utf-8")
      .then((data: string) => JSON.parse(data));
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const buf = await fsp.readFile(this.path);
    return buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
  }

  async blob(): Promise<Blob> {
    // Carry a content-type (from the extension) so the Blob round-trips through
    // FormData / Response with the right type, like the remote providers do.
    const type = getContentType(this.path);
    return new Blob([await fsp.readFile(this.path)], type ? { type } : {});
  }

  async bytes(): Promise<Uint8Array> {
    return new Uint8Array(await this.arrayBuffer());
  }

  async write(content: WriteContent, _options?: WriteOptions): Promise<void> {
    if (typeof content === "string") {
      await fsp.mkdir(dirname(this.path), { recursive: true });
      return fsp.writeFile(this.path, content);
    }
    if (content instanceof Buffer || content instanceof Uint8Array) {
      await fsp.mkdir(dirname(this.path), { recursive: true });
      return fsp.writeFile(this.path, content);
    }
    if (content instanceof Blob) {
      await fsp.mkdir(dirname(this.path), { recursive: true });
      return fsp.writeFile(this.path, Buffer.from(await content.arrayBuffer()));
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

  async copyTo(path: string): Promise<void> {
    const dst = resolve(isAbsolute(path) ? path : join(this.#root, path));
    await fsp.mkdir(dirname(dst), { recursive: true });
    await fsp.copyFile(this.path, dst);
  }

  async moveTo(path: string): Promise<void> {
    const dst = resolve(isAbsolute(path) ? path : join(this.#root, path));
    await fsp.mkdir(dirname(dst), { recursive: true });
    await fsp.rename(this.path, dst);
  }

  async rename(name: string): Promise<void> {
    if (name.includes("/"))
      throw new Error("rename() cannot change directory, use moveTo() instead");
    const relDir = this.path
      .slice(this.#root.length)
      .split("/")
      .slice(0, -1)
      .join("/");
    await this.moveTo(relDir ? relDir + "/" + name : name);
  }

  async remove(): Promise<void> {
    return fsp.unlink(this.path);
  }

  publicUrl(): null {
    return null;
  }

  async signedUrl(_opts: { expires: number | string }): Promise<null> {
    return null;
  }

  async uploadUrl(_opts: { expires: number | string }): Promise<null> {
    return null;
  }

  stream(): ReadableStream {
    return Readable.toWeb(
      createReadStream(this.path),
    ) as unknown as ReadableStream;
  }

  nodeReadable(): NodeJS.ReadableStream {
    return createReadStream(this.path);
  }

  nodeWritable(_options?: WriteOptions): NodeJS.WritableStream {
    return Writable.fromWeb(this.writable() as WritableStream<Uint8Array>);
  }

  writable(_options?: WriteOptions): WritableStream {
    const filePath = this.path;
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
