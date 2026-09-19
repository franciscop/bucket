import { Blob } from "node:buffer";
import { Readable, Writable } from "node:stream";

import BucketError from "../lib/BucketError.ts";
import { resolveContentType, getContentType } from "../lib/fileTypes.ts";
import { destKey } from "../lib/prefix.ts";
import { publicUrlFrom } from "../lib/publicUrl.ts";
import { throwIfAborted, type ReadOptions } from "../lib/abort.ts";
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

/** What the Map holds: the bytes plus everything write() was told about them. */
export interface MemoryEntry {
  data: Buffer;
  type: string | null;
  modified: Date;
  cacheControl?: string;
  disposition?: string;
  metadata: Record<string, string>;
}

/** The bucket's store, shared by every file handle it hands out. */
export interface MemoryStore {
  files: Map<string, MemoryEntry>;
  publicUrl: string;
  prefix: string;
}

const notFound = (path: string): never => {
  throw new BucketError(`Memory file not found: ${path}`, {
    provider: "MEMORY",
    code: "NOT_FOUND",
  });
};

// Remote providers lowercase custom metadata keys (S3, Azure and B2 all send
// them as headers), so do the same here or code developed against Memory would
// break on the first real bucket.
const normalizeMeta = (meta: Record<string, string> = {}) =>
  Object.fromEntries(
    Object.entries(meta).map(([k, v]) => [k.toLowerCase(), v]),
  );

export class MemoryFile implements BucketFile {
  name: string;
  path: string;
  #store: MemoryStore;
  #range: ByteRange | null = null;

  constructor(path: string, store: MemoryStore) {
    this.path = path.startsWith("/") ? path.slice(1) : path;
    this.name = this.path.split("/").pop() || this.path;
    this.#store = store;
  }

  slice(start: number, end?: number): MemoryFile {
    const f = new MemoryFile(this.path, this.#store);
    f.#range = composeRange(this.#range, start, end);
    return f;
  }

  #entry(): MemoryEntry | undefined {
    return this.#store.files.get(this.path);
  }

  // The bytes this handle sees, which is the slice when one is set.
  #read(opts?: ReadOptions): Buffer {
    throwIfAborted(opts?.signal);
    const entry = this.#entry();
    if (!entry) notFound(this.path);
    if (!this.#range) return entry!.data;
    if (isEmptyRange(this.#range)) return Buffer.alloc(0);
    const { start, end } = this.#range;
    return entry!.data.subarray(start, end);
  }

  async info(opts?: ReadOptions): Promise<FileInfo | null> {
    throwIfAborted(opts?.signal);
    const entry = this.#entry();
    if (!entry) return null;
    return {
      size: rangeSize(this.#range, entry.data.length),
      type: entry.type,
      modified: entry.modified,
      // Nothing is versioned here: remove() deletes.
      version: null,
      metadata: { ...entry.metadata },
      ...(entry.cacheControl ? { cacheControl: entry.cacheControl } : {}),
      ...(entry.disposition ? { disposition: entry.disposition } : {}),
    } as FileInfo;
  }

  async exists(opts?: ReadOptions): Promise<boolean> {
    throwIfAborted(opts?.signal);
    return this.#entry() !== undefined;
  }

  async text(opts?: ReadOptions): Promise<string> {
    return this.#read(opts).toString("utf-8");
  }

  async json(opts?: ReadOptions): Promise<unknown> {
    return JSON.parse(this.#read(opts).toString("utf-8"));
  }

  async arrayBuffer(opts?: ReadOptions): Promise<ArrayBuffer> {
    const buf = this.#read(opts);
    return buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
  }

  async blob(opts?: ReadOptions): Promise<Blob> {
    const type = this.#entry()?.type ?? getContentType(this.path);
    return new Blob([new Uint8Array(this.#read(opts))], type ? { type } : {});
  }

  async bytes(opts?: ReadOptions): Promise<Uint8Array> {
    return new Uint8Array(this.#read(opts));
  }

  // The single place an entry is created, so every write path records the
  // same metadata: nothing a caller passes is dropped.
  #store_(data: Buffer, options: WriteOptions = {}, content?: unknown): void {
    this.#store.files.set(this.path, {
      data,
      type: resolveContentType(this.path, content as Blob, options) ?? null,
      modified: new Date(),
      cacheControl: options.cacheControl,
      disposition: options.disposition,
      metadata: normalizeMeta(options.metadata),
    });
  }

  async write(
    content: WriteContent,
    options?: WriteOptions,
  ): Promise<MemoryFile> {
    throwIfAborted(options?.signal);
    this.#store_(await toBuffer(content, options), options, content);
    return this;
  }

  async copyTo(
    dest: string | BucketFile,
    opts?: ReadOptions,
  ): Promise<BucketFile> {
    throwIfAborted(opts?.signal);
    if (typeof dest !== "string") return dest.write(this, opts);
    const entry = this.#entry();
    if (!entry) notFound(this.path);
    const dst = new MemoryFile(
      destKey(this.#store.prefix, dest, this.name),
      this.#store,
    );
    // A copy of the bytes, not a shared reference: writing to one file must
    // never mutate the other.
    this.#store.files.set(dst.path, {
      ...entry!,
      data: Buffer.from(entry!.data),
      metadata: { ...entry!.metadata },
      modified: new Date(),
    });
    return dst;
  }

  async moveTo(
    dest: string | BucketFile,
    opts?: ReadOptions,
  ): Promise<BucketFile> {
    const moved = await this.copyTo(dest, opts);
    await this.remove(opts);
    return moved;
  }

  async rename(name: string, opts?: ReadOptions): Promise<BucketFile> {
    if (!name || name === "." || name === "..")
      throw new Error(`rename() needs a file name, got "${name}"`);
    if (name.includes("/"))
      throw new Error("rename() cannot change directory, use moveTo() instead");
    const prefix = this.#store.prefix;
    const rel = prefix ? this.path.slice(prefix.length + 1) : this.path;
    const dir = rel.split("/").slice(0, -1).join("/");
    return this.moveTo(dir ? dir + "/" + name : name, opts);
  }

  async remove(opts?: ReadOptions): Promise<MemoryFile> {
    throwIfAborted(opts?.signal);
    // Already gone is success: removing a path twice is a no-op
    this.#store.files.delete(this.path);
    return this;
  }

  // Bun-style aliases, so muscle memory from Bun's S3File carries over
  unlink(opts?: ReadOptions): Promise<MemoryFile> {
    return this.remove(opts);
  }

  async publicUrl(): Promise<string | null> {
    // Nothing serves these bytes, so there is no canonical URL to fall back on.
    const base = this.#store.publicUrl;
    return base ? publicUrlFrom(base, this.path) : null;
  }

  async signedUrl(_opts: { expires: number | string }): Promise<null> {
    // Nothing to sign: there is no endpoint behind an in-memory bucket.
    return null;
  }

  async uploadUrl(_opts: { expires: number | string }): Promise<null> {
    return null;
  }

  stream(opts?: ReadOptions): ReadableStream {
    const data = this.#read(opts);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(data));
        controller.close();
      },
    });
  }

  nodeReadable(opts?: ReadOptions): NodeJS.ReadableStream {
    return Readable.from([this.#read(opts)]);
  }

  writable(options?: WriteOptions): WritableStream {
    const chunks: Buffer[] = [];
    const commit = (data: Buffer) => this.#store_(data, options);
    return new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(Buffer.from(chunk));
      },
      close() {
        // Committed only on close, so a reader never sees a partial write.
        commit(Buffer.concat(chunks));
      },
      abort() {
        chunks.length = 0;
      },
    });
  }

  nodeWritable(options?: WriteOptions): NodeJS.WritableStream {
    return Writable.fromWeb(
      this.writable(
        options,
      ) as import("node:stream/web").WritableStream<Uint8Array>,
    );
  }
}

// Every WriteContent variant collapses to a Buffer; there is nothing to chunk.
async function toBuffer(
  content: WriteContent,
  options?: WriteOptions,
): Promise<Buffer> {
  if (typeof content === "string") return Buffer.from(content);
  if (Buffer.isBuffer(content)) return Buffer.from(content);
  if (content instanceof Uint8Array) return Buffer.from(content);
  if (content instanceof Blob) return Buffer.from(await content.arrayBuffer());
  // A BucketFile from this or any other provider
  if (
    typeof (content as BucketFile).stream === "function" &&
    typeof (content as BucketFile).info === "function"
  ) {
    return Buffer.from(await (content as BucketFile).bytes());
  }
  if (typeof (content as ReadableStream).pipeTo === "function") {
    const chunks: Buffer[] = [];
    const reader = (content as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  if (content instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of content) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  void options;
  throw new Error("Invalid content type");
}
