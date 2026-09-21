/** Metadata returned by `file.info()`; `info()` resolves to `null` when the
 * file does not exist, so every field here is always real. */
export interface FileInfo {
  /** File size in bytes (respects `.slice()` ranges) */
  size: number;
  /** MIME type, or null if unknown */
  type: string | null;
  /** When the file content was last written */
  modified: Date;
  /** Provider version identifier: the fileId on B2, `generation` on GCS,
   * `VersionId` on S3/Azure when versioning is enabled; null otherwise */
  version: string | null;
  /** Custom metadata (lowercase keys); empty when none or unsupported */
  metadata: Record<string, string>;
  /** Cache-Control the file was written with, when the provider reports it */
  cacheControl?: string;
  /** Content-Disposition the file was written with, when the provider
   * reports it */
  disposition?: string;
}

/** Metadata returned by `bucket.info()`. Every provider returns the same shape. */
export interface BucketInfo {
  /** Provider type, e.g. "S3", "R2", "GCS", "AZURE", "BACKBLAZE", "FILESYSTEM" */
  type: string;
  /** Bucket, container, or folder name */
  name: string;
  /** Base URL of the bucket (the root folder path for the filesystem) */
  url: string;
  /** Account or credential identifier (provider-specific) */
  id: string;
}

/** Accepted input types for `file.write()` */
export type WriteContent =
  | string
  | Buffer
  | Uint8Array
  | Blob
  | BucketFile
  | ReadableStream
  | NodeJS.ReadableStream;

/** Options for `file.write()`, `file.writable()`, and `file.nodeWritable()` */
export type { ReadOptions } from "./abort.ts";
import type { ReadOptions } from "./abort.ts";

export interface WriteOptions extends ReadOptions {
  /** MIME type (`"image/png"`) or extension (`"png"`, `".png"`),
   * auto-detected from the file extension if omitted */
  type?: string;
  /** Cache-Control header value, e.g. `"max-age=31536000, public"` */
  cacheControl?: string;
  /** Content-Disposition header value, e.g. `"attachment; filename=file.txt"` */
  disposition?: string;
  /** Custom metadata key-value pairs */
  metadata?: Record<string, string>;
}

/** A handle to a single file within a bucket */
export interface BucketFile {
  /** Filename only (no directory) */
  name: string;
  /** Full path within the bucket */
  path: string;

  /** Returns the file's metadata (size, type, modified, version, custom
   * metadata), or `null` when the file does not exist */
  info(opts?: ReadOptions): Promise<FileInfo | null>;
  /** Returns `true` if the file exists */
  exists(opts?: ReadOptions): Promise<boolean>;

  /** Downloads and returns the file content as a string */
  text(opts?: ReadOptions): Promise<string>;
  /** Downloads and parses the file content as JSON */
  json(opts?: ReadOptions): Promise<unknown>;
  /** Downloads and returns the file content as an `ArrayBuffer` */
  arrayBuffer(opts?: ReadOptions): Promise<ArrayBuffer>;
  /** Downloads and returns the file content as a `Blob` */
  blob(opts?: ReadOptions): Promise<Blob>;
  /** Downloads and returns the file content as a `Uint8Array` */
  bytes(opts?: ReadOptions): Promise<Uint8Array>;

  /** Writes content to the file, replacing any existing content.
   * Resolves to this same file. */
  write(content: WriteContent, options?: WriteOptions): Promise<BucketFile>;

  /** Copies this file to a path (same bucket) or a file in any bucket.
   * Resolves to the destination file. */
  copyTo(dest: string | BucketFile, opts?: ReadOptions): Promise<BucketFile>;
  /** Moves this file (copy + delete) to a path or a file in any bucket.
   * Resolves to the destination file. */
  moveTo(dest: string | BucketFile, opts?: ReadOptions): Promise<BucketFile>;
  /**
   * Renames the file within its current directory, resolving to the renamed
   * file. Throws if `name` contains a `/`, use `moveTo()` to change directories.
   */
  rename(name: string, opts?: ReadOptions): Promise<BucketFile>;
  /** Deletes the file, resolving to it. Aliases: `unlink()`, `delete()` */
  remove(opts?: ReadOptions): Promise<BucketFile>;
  /** Alias of `remove()` (Bun `S3File.unlink()`) */
  unlink(opts?: ReadOptions): Promise<BucketFile>;

  /**
   * A read-only view of a byte range of this file, like `Blob.slice()`:
   * `end` is exclusive and defaults to the end of the file. Every read method
   * (`text`, `bytes`, `arrayBuffer`, `blob`, `stream`, ...) honours the range,
   * and `info().size` reports the clamped slice length. Ranges compose.
   */
  slice(start: number, end?: number): BucketFile;

  /** Returns a web `ReadableStream` of the file content. Both readers are
   * synchronous and fetch lazily, so a signal has to be given up front here
   * rather than awaited on. */
  stream(opts?: ReadOptions): ReadableStream;
  /** Returns a Node.js `ReadableStream` of the file content */
  nodeReadable(opts?: ReadOptions): NodeJS.ReadableStream;
  /** Returns a web `WritableStream` that writes to this file */
  writable(options?: WriteOptions): WritableStream;
  /** Returns a Node.js `WritableStream` that writes to this file */
  nodeWritable(options?: WriteOptions): NodeJS.WritableStream;

  /** Returns the permanent public URL, or `null` when the provider has no
   * public URL for this file. The URL only answers if the bucket or object
   * is configured publicly readable. */
  publicUrl(): Promise<string | null>;
  /** Returns a time-limited signed URL for downloading the file */
  signedUrl(opts: { expires: number | string }): Promise<string | null>;
  /** Returns a time-limited signed URL for uploading to this file path */
  uploadUrl(opts: { expires: number | string }): Promise<string | null>;
}

/** A bucket (or container) that holds files */
export interface Bucket {
  /** Provider type: "S3", "R2", "GCS", "AZURE", "BACKBLAZE", "FILESYSTEM"
   * or "MEMORY". Always set, and always equal to `info().type`. */
  type: string;

  /** Returns metadata about the bucket */
  info(opts?: ReadOptions): Promise<BucketInfo>;
  /** Lists all files in the bucket, optionally filtered by a `RegExp`. */
  list(filter?: RegExp, opts?: ReadOptions): Promise<BucketFile[]>;
  /**
   * Lazily iterates files, streaming provider pages as they arrive (bounded
   * memory, supports early `break`). Optionally filtered by a `RegExp`.
   */
  scan(filter?: RegExp, opts?: ReadOptions): AsyncGenerator<BucketFile>;
  /**
   * Deletes every file matching the filter, returning the deleted files.
   * The filter is required and must be a `RegExp`: use `.remove(/./)` to empty
   * the bucket, or `.folder(path)` to scope it first. Anything else throws a
   * `BucketError` with code `"INVALID_FILTER"`.
   */
  remove(filter: RegExp, opts?: ReadOptions): Promise<BucketFile[]>;
  /** Returns the number of files matching the optional filter */
  count(filter?: RegExp, opts?: ReadOptions): Promise<number>;
  /** Returns a file handle for the given path (does not check existence) */
  file(name: string): BucketFile;
  /**
   * Writes the content under a random file name, resolving to the new file.
   * The extension comes from `options.type`, or from a name the content
   * carries of its own (a `File`, or a file from any bucket).
   */
  create(content: WriteContent, options?: WriteOptions): Promise<BucketFile>;
  /** Returns a folder: a copy of this bucket scoped to the given path prefix */
  folder(path: string): Bucket;
  /** Iterates over all files in the bucket */
  [Symbol.asyncIterator](): AsyncIterator<BucketFile>;
}

export interface S3Auth {
  id: string;
  secret: string;
  region: string;
  sessionToken?: string;
}
