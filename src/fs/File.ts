import { getContentType } from "../lib/contentType.ts";
import BucketError from "../lib/BucketError.ts";
import { destKey } from "../lib/prefix.ts";
import { throwIfAborted, withAbort, type ReadOptions } from "../lib/abort.ts";
import { isEmptyRange, rangeSize } from "../lib/range.ts";
import { BaseFile, wholeBody, type FileContext } from "../lib/base.ts";
import assertNotOsPath from "./osPathGuard.ts";
import * as node from "../lib/node.ts";
import type { BucketFile, FileInfo, WriteOptions } from "../lib/types.ts";

// Map a Node filesystem error to a BucketError so `.code` is uniform with the
// remote providers (ENOENT → NOT_FOUND, permission → FORBIDDEN).
export function fsError(err: unknown): never {
  if (err instanceof BucketError) throw err;
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

export interface FSContext extends FileContext {
  root: string;
}

export class FSFile extends BaseFile<FSContext> {
  // The OS location is private; derive it externally with join(root, file.path).
  get #abs(): string {
    return node.path.join(this.ctx.root, this.path);
  }

  // Wraps the bytes as a Response so the shared readers work unchanged; the
  // content type comes from the extension, as there is no metadata store.
  protected async fetch(opts?: ReadOptions): Promise<Response> {
    const type = getContentType(this.path);
    return new Response(new Uint8Array(await this.#read(opts?.signal)), {
      headers: type ? { "content-type": type } : {},
    });
  }

  async #read(signal?: AbortSignal): Promise<Buffer> {
    if (!this.range)
      return withAbort(signal, () =>
        node.fsp.readFile(this.#abs, { signal }),
      ).catch(fsError);
    const { start, end } = this.range;
    const fh = await node.fsp.open(this.#abs).catch(fsError);
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

  async info(opts?: ReadOptions): Promise<FileInfo | null> {
    throwIfAborted(opts?.signal);
    let stat: { size: number; mtime: Date };
    try {
      stat = await node.fsp.stat(this.#abs);
    } catch {
      return null;
    }
    return {
      size: rangeSize(this.range, stat.size),
      type: getContentType(this.path) ?? null,
      modified: new Date(stat.mtime),
      version: null,
      metadata: {},
    };
  }

  // The filesystem has no metadata store, so every write option but the
  // bytes is dropped; node.fsp.writeFile with a signal removes a partial file itself.
  protected async put(data: Uint8Array, options: WriteOptions): Promise<void> {
    await node.fsp.mkdir(node.path.dirname(this.#abs), { recursive: true });
    await node.fsp.writeFile(this.#abs, data, { signal: options.signal });
  }

  protected target(options: WriteOptions) {
    return wholeBody((data) => this.put(data, options));
  }

  // The OS-path guard runs on the raw destination, before the base resolves it.
  copyTo(dest: string | BucketFile, opts?: ReadOptions) {
    if (typeof dest === "string") assertNotOsPath(this.ctx.root, dest);
    return super.copyTo(dest, opts);
  }

  protected async copy(key: string): Promise<void> {
    const dst = this.at(key);
    await node.fsp.mkdir(node.path.dirname(dst.#abs), { recursive: true });
    await node.fsp.copyFile(this.#abs, dst.#abs).catch(fsError);
  }

  // A single atomic rename rather than copy + unlink.
  async moveTo(
    dest: string | BucketFile,
    opts?: ReadOptions,
  ): Promise<BucketFile> {
    throwIfAborted(opts?.signal);
    if (typeof dest !== "string") return super.moveTo(dest, opts);
    assertNotOsPath(this.ctx.root, dest);
    const dst = this.at(destKey(this.ctx.prefix, dest, this.name));
    await node.fsp.mkdir(node.path.dirname(dst.#abs), { recursive: true });
    await node.fsp.rename(this.#abs, dst.#abs).catch(fsError);
    return dst;
  }

  protected async delete(): Promise<void> {
    await node.fsp.unlink(this.#abs).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") fsError(err);
    });
  }

  // Nothing canonical: the library does not serve the files.
  protected async canonicalUrl() {
    return null;
  }

  async signedUrl(_opts: { expires: number | string }): Promise<null> {
    return null;
  }

  async uploadUrl(_opts: { expires: number | string }): Promise<null> {
    return null;
  }

  // Streams straight from disk instead of buffering the whole file.
  stream(opts?: ReadOptions): ReadableStream {
    return node.stream!.Readable.toWeb(
      this.nodeReadable(opts) as import("node:stream").Readable,
    ) as unknown as ReadableStream;
  }

  nodeReadable(opts?: ReadOptions): NodeJS.ReadableStream {
    const signal = opts?.signal;
    if (!this.range) return node.fs.createReadStream(this.#abs, { signal });
    if (isEmptyRange(this.range)) return node.stream!.Readable.from([]);
    const { start, end } = this.range;
    // Node's `end` is inclusive; our range end is exclusive.
    return node.fs.createReadStream(this.#abs, {
      start,
      signal,
      ...(end !== undefined ? { end: end - 1 } : {}),
    });
  }

  writable(_options?: WriteOptions): WritableStream {
    // Stream into a temp sibling and rename on close: readers never observe
    // a half-written file, and a failed or aborted write leaves the previous
    // content (or absence) untouched.
    const finalPath = this.#abs;
    const tmpPath = `${finalPath}.tmp-${Math.random().toString(36).slice(2)}`;
    let writer: import("node:fs").WriteStream | null = null;

    return new WritableStream<Uint8Array>({
      async start() {
        await node.fsp.mkdir(node.path.dirname(finalPath), {
          recursive: true,
        });
        writer = node.fs.createWriteStream(tmpPath);
        await new Promise<void>((resolve, reject) => {
          writer!.once("open", resolve);
          writer!.once("error", reject);
        });
      },
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          const ok = writer!.write(chunk);
          if (ok) resolve();
          else writer!.once("drain", resolve);
          writer!.once("error", reject);
        });
      },
      async close() {
        await new Promise<void>((resolve, reject) => {
          writer!.end((err?: Error | null) => (err ? reject(err) : resolve()));
        });
        await node.fsp.rename(tmpPath, finalPath);
      },
      async abort() {
        writer?.destroy();
        await node.fsp.unlink(tmpPath).catch(() => {});
      },
    });
  }
}
