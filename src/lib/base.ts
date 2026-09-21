// Everything a provider does NOT have to write. A file is defined by its
// primitives (fetch a range, describe itself, put a body, open a chunked
// target, copy to a key, delete, sign a URL); a bucket by two (list a page,
// describe itself). The public API is derived from those here, once, so the
// seven providers agree by construction rather than by copy.
//
// Both halves share one context object, which carries what every provider has
// (its label, the folder prefix, the public origin) plus whatever that
// provider needs. folder() copies the context with a new prefix, so anything
// held by reference in there, notably an auth or token cache, is shared with
// every folder rather than re-resolved or hand-copied.
import BucketError from "./BucketError.ts";
import { stream } from "./node.ts";
import chunkedWritable, {
  writeChunked,
  type ChunkedTarget,
} from "./chunkedWritable.ts";
import { checkStatus } from "./http.ts";
import parse from "./parse.ts";
import promiseToReadable from "./promiseToReadable.ts";
import { publicUrlFrom } from "./publicUrl.ts";
import { throwIfAborted, withAbort, type ReadOptions } from "./abort.ts";
import { assertFilter, requireFilter } from "./filter.ts";
import { randomName } from "./nanoid.ts";
import { destKey, fileKey, folderKey } from "./prefix.ts";
import { composeRange, isEmptyRange, type ByteRange } from "./range.ts";
import { writeMeta, type WriteMeta } from "./writeMeta.ts";
import type {
  Bucket,
  BucketFile,
  BucketInfo,
  FileInfo,
  WriteContent,
  WriteOptions,
} from "./types.ts";

/** What every provider's context carries, whatever else it adds. */
export interface FileContext {
  /** Label for error messages and `BucketError.provider`. */
  provider: string;
  /** Folder prefix of the bucket this handle came from. */
  prefix: string;
  /** Configured public origin; "" when unset. */
  publicUrl: string;
}

/** Seconds from an `expires` option, defaulting to an hour. */
export const expiresIn = (opts: { expires: number | string }): number =>
  parse(opts.expires) ?? 3600;

export abstract class BaseFile<
  Ctx extends FileContext = FileContext,
> implements BucketFile {
  name: string;
  path: string;
  protected readonly ctx: Ctx;
  protected range: ByteRange | null = null;

  constructor(path: string, ctx: Ctx) {
    this.path = path.startsWith("/") ? path.slice(1) : path;
    this.name = this.path.split("/").pop() || this.path;
    this.ctx = ctx;
  }

  // ── What a provider implements ──────────────────────────────────────────

  /** Range-aware, status-checked GET. The empty-range shortcut is handled
   * by the base, so `this.range` here is never empty. */
  protected abstract fetch(opts?: ReadOptions): Promise<Response>;
  /** One-request upload of a whole body. */
  protected abstract put(data: Buffer, options: WriteOptions): Promise<void>;
  /** The provider's chunked-upload mechanism; the base runs the machine. */
  protected abstract target(
    options: WriteOptions,
  ): ChunkedTarget<unknown, unknown>;
  /** Server-side copy of this file to an already-resolved key in the same
   * bucket. Providers without one stream the bytes through. */
  protected abstract copy(key: string, opts?: ReadOptions): Promise<void>;
  /** Deletes this file. Already gone is success, so removing twice is a no-op. */
  protected abstract delete(opts?: ReadOptions): Promise<void>;
  /** The provider's own public address, or null when it has none. */
  protected abstract canonicalUrl(): Promise<string | null>;
  abstract info(opts?: ReadOptions): Promise<FileInfo | null>;
  abstract signedUrl(opts: {
    expires: number | string;
  }): Promise<string | null>;
  abstract uploadUrl(opts: {
    expires: number | string;
  }): Promise<string | null>;

  // ── Derived ───────────────────────────────────────────────────────────────

  protected get provider(): string {
    return this.ctx.provider;
  }

  /** A fresh handle for another key in the same bucket scope. */
  protected at(path: string): this {
    const Self = this.constructor as new (path: string, ctx: Ctx) => this;
    return new Self(path, this.ctx);
  }

  /** Throws a BucketError unless the response is ok or in `also`. */
  protected check(res: Response, what: string, ...also: number[]): Response {
    return checkStatus(res, this.provider, what, ...also);
  }

  /** The write options, resolved into the shape every provider maps from. */
  protected meta(options: WriteOptions, content?: Blob): WriteMeta {
    return writeMeta(this.path, options, content);
  }

  slice(start: number, end?: number): this {
    const f = this.at(this.path);
    f.range = composeRange(this.range, start, end);
    return f;
  }

  protected async get(opts?: ReadOptions): Promise<Response> {
    throwIfAborted(opts?.signal);
    if (this.range && isEmptyRange(this.range))
      return new Response(new Uint8Array(0));
    return this.fetch(opts);
  }

  async exists(opts?: ReadOptions): Promise<boolean> {
    throwIfAborted(opts?.signal);
    return (await this.info(opts)) !== null;
  }

  async text(opts?: ReadOptions): Promise<string> {
    return (await this.get(opts)).text();
  }

  async json(opts?: ReadOptions): Promise<unknown> {
    return (await this.get(opts)).json();
  }

  async arrayBuffer(opts?: ReadOptions): Promise<ArrayBuffer> {
    return (await this.get(opts)).arrayBuffer();
  }

  async blob(opts?: ReadOptions): Promise<Blob> {
    return (await this.get(opts)).blob();
  }

  async bytes(opts?: ReadOptions): Promise<Uint8Array> {
    return new Uint8Array(await this.arrayBuffer(opts));
  }

  async write(
    content: WriteContent,
    options: WriteOptions = {},
  ): Promise<this> {
    // One wrapper for every provider: whatever a put() rejects with mid-flight
    // after the signal fired comes out as our ABORTED error.
    await withAbort(options.signal, () => this.dispatch(content, options));
    return this;
  }

  private async dispatch(
    content: WriteContent,
    options: WriteOptions,
  ): Promise<void> {
    if (typeof content === "string" || content instanceof Uint8Array)
      await writeChunked(this.target(options), Buffer.from(content));
    else if (content instanceof Blob)
      await writeChunked(
        this.target({
          ...options,
          type: this.meta(options, content).type ?? undefined,
        }),
        Buffer.from(await content.arrayBuffer()),
      );
    // A BucketFile from this or any other provider: stream it across
    else if (typeof (content as BucketFile).info === "function")
      await (content as BucketFile).stream().pipeTo(this.writable(options));
    else if (typeof (content as ReadableStream).pipeTo === "function")
      await (content as ReadableStream).pipeTo(this.writable(options));
    else if (stream && content instanceof stream.Readable)
      await stream.Readable.toWeb(content).pipeTo(this.writable(options));
    else
      throw new BucketError(
        "write() needs a string, Buffer, Blob, stream, or a file from any bucket",
        { code: "INVALID_CONTENT" },
      );
  }

  async copyTo(
    dest: string | BucketFile,
    opts?: ReadOptions,
  ): Promise<BucketFile> {
    throwIfAborted(opts?.signal);
    // A file in this or any other bucket: stream the bytes across
    if (typeof dest !== "string") return dest.write(this, opts);
    const key = destKey(this.ctx.prefix, dest, this.name);
    await this.copy(key, opts);
    return this.at(key);
  }

  async remove(opts?: ReadOptions): Promise<this> {
    throwIfAborted(opts?.signal);
    await this.delete(opts);
    return this;
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
      throw new BucketError(`rename() needs a file name, got "${name}"`, {
        code: "INVALID_PATH",
      });
    if (name.includes("/"))
      throw new BucketError(
        "rename() cannot change directory, use moveTo() instead",
        { code: "INVALID_PATH" },
      );
    const rel = this.ctx.prefix
      ? this.path.slice(this.ctx.prefix.length + 1)
      : this.path;
    const dir = rel.split("/").slice(0, -1).join("/");
    return this.moveTo(dir ? dir + "/" + name : name, opts);
  }

  // Bun-style alias, so muscle memory from Bun's S3File carries over
  unlink(opts?: ReadOptions): Promise<this> {
    return this.remove(opts);
  }

  stream(opts?: ReadOptions): ReadableStream {
    return promiseToReadable(async () => (await this.get(opts)).body!);
  }

  // The node* methods are the one place a missing Node runtime is an error.
  #node(): NonNullable<typeof stream> {
    if (!stream)
      throw new BucketError("Node streams are not available in this runtime", {
        code: "INVALID_CONTENT",
      });
    return stream;
  }

  nodeReadable(opts?: ReadOptions): NodeJS.ReadableStream {
    return this.#node().Readable.fromWeb(
      this.stream(
        opts,
      ) as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
    );
  }

  writable(options: WriteOptions = {}): WritableStream {
    return chunkedWritable(this.target(options));
  }

  nodeWritable(options?: WriteOptions): NodeJS.WritableStream {
    return this.#node().Writable.fromWeb(
      this.writable(options) as import("node:stream/web").WritableStream,
    );
  }

  async publicUrl(): Promise<string | null> {
    return this.ctx.publicUrl
      ? publicUrlFrom(this.ctx.publicUrl, this.path)
      : this.canonicalUrl();
  }
}

/** A chunked target for providers with nothing to chunk: one put() on close. */
export function wholeBody(
  put: (data: Buffer) => Promise<void>,
): ChunkedTarget<never, never> {
  return {
    partSize: Infinity,
    single: put,
    start: async () => undefined as never,
    part: async () => undefined as never,
    finish: async () => {},
    abort: async () => {},
  };
}

export abstract class BaseBucket<
  Ctx extends FileContext,
  F extends BaseFile<Ctx>,
> implements Bucket {
  abstract readonly type: string;
  protected readonly ctx: Ctx;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  // ── What a provider implements ──────────────────────────────────────────

  /** Yields the bucket's files a provider page at a time, already scoped to
   * the folder and filter. */
  protected abstract pages(
    filter?: RegExp,
    opts?: ReadOptions,
  ): AsyncGenerator<F[]>;
  /** A handle for an already-resolved key. */
  protected abstract make(key: string): F;
  abstract info(opts?: ReadOptions): Promise<BucketInfo>;

  // ── Derived ───────────────────────────────────────────────────────────────

  get PREFIX(): string {
    return this.ctx.prefix;
  }

  /** Throws a BucketError unless the response is ok or in `also`. */
  protected check(res: Response, what: string, ...also: number[]): Response {
    return checkStatus(res, this.ctx.provider, what, ...also);
  }

  file(name: string): F {
    if (!name)
      throw new BucketError("file() needs a name", { code: "INVALID_PATH" });
    return this.make(fileKey(this.PREFIX, name));
  }

  folder(path: string): this {
    const Self = this.constructor as new (ctx: Ctx) => this;
    // Same context, new prefix: an auth or token cache inside it is shared
    // with the folder rather than resolved again.
    return new Self({ ...this.ctx, prefix: folderKey(this.PREFIX, path) });
  }

  /** Deletes the listed files, returning the ones confirmed gone. Overridden
   * where the provider has a batch delete. */
  protected async removeAll(files: F[], opts?: ReadOptions): Promise<F[]> {
    await Promise.all(files.map((f) => f.remove(opts)));
    return files;
  }

  scan(filter?: RegExp, opts?: ReadOptions): AsyncGenerator<F> {
    assertFilter(filter);
    // Eager, like the filter check: an aborted scan must not wait for the
    // first iteration to reject.
    throwIfAborted(opts?.signal);
    return this.iterate(filter, opts);
  }

  private async *iterate(filter?: RegExp, opts?: ReadOptions) {
    for await (const page of this.pages(filter, opts)) {
      for (const file of page) {
        throwIfAborted(opts?.signal);
        yield file;
      }
    }
  }

  async list(filter?: RegExp, opts?: ReadOptions): Promise<F[]> {
    assertFilter(filter);
    throwIfAborted(opts?.signal);
    const files: F[] = [];
    for await (const page of this.pages(filter, opts)) files.push(...page);
    return files;
  }

  async count(filter?: RegExp, opts?: ReadOptions): Promise<number> {
    return (await this.list(filter, opts)).length;
  }

  async remove(filter: RegExp, opts?: ReadOptions): Promise<F[]> {
    requireFilter(filter);
    throwIfAborted(opts?.signal);
    const files = await this.list(filter, opts);
    return files.length ? this.removeAll(files, opts) : [];
  }

  async create(content: WriteContent, options?: WriteOptions): Promise<F> {
    throwIfAborted(options?.signal);
    return this.file(randomName(content, options)).write(content, options);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<F> {
    yield* this.scan();
  }
}
