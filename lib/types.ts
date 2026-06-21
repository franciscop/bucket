/** Metadata returned by `file.info()` */
export interface FileInfo {
  /** File identifier: the path for remote stores, a hash for the filesystem */
  id: string;
  /** Filename only (no directory) */
  name: string;
  /** Full path within the bucket */
  path: string;
  /** Whether the file exists */
  exists: boolean;
  /** MIME type, or null if unknown or file does not exist */
  type: string | null;
  /** File size in bytes */
  size: number;
  /** Last-modified date, or null if unknown or file does not exist */
  date: Date | null;
  /** Public URL, or null if not publicly accessible */
  url: string | null;
}

/** Metadata returned by `bucket.info()`. Every provider returns the same shape. */
export interface BucketInfo {
  /** Provider type, e.g. "S3", "R2", "GCS", "AZURE", "BACKBLAZE", "FILESYSTEM" */
  type: string;
  /** Bucket, container, or folder name */
  name: string;
  /** Base URL of the bucket (the root folder path for the filesystem) */
  endpoint: string;
  /** Account or credential identifier (provider-specific) */
  id: string;
}

export interface FileEntry {
  id: string;
  name: string;
  path: string;
  type: string | null;
  size: number;
  date: Date | null;
  url?: string | null;
}

/** Accepted input types for `file.write()` */
export type WriteContent =
  | string
  | Buffer
  | Uint8Array
  | Blob
  | IBucketFile
  | ReadableStream
  | NodeJS.ReadableStream;

/** Options for `file.write()`, `file.writable()`, and `file.nodeWritable()` */
export interface WriteOptions {
  /** MIME type, auto-detected from file extension if omitted */
  type?: string;
  /** Cache-Control header value, e.g. `"max-age=31536000, public"` */
  cacheControl?: string;
  /** Content-Disposition header value, e.g. `"attachment; filename=file.txt"` */
  disposition?: string;
  /** Custom metadata key-value pairs */
  metadata?: Record<string, string>;
}

/** A handle to a single file within a bucket */
export interface IBucketFile {
  /** File identifier: the path for remote stores, a hash for the filesystem */
  id: string;
  /** Filename only (no directory) */
  name: string;
  /** Full path within the bucket */
  path: string;

  /** Returns metadata about the file (existence, size, type, date, URL) */
  info(): Promise<FileInfo>;
  /** Returns `true` if the file exists */
  exists(): Promise<boolean>;

  /** Downloads and returns the file content as a string */
  text(): Promise<string>;
  /** Downloads and parses the file content as JSON */
  json(): Promise<unknown>;
  /** Downloads and returns the file content as an `ArrayBuffer` */
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Downloads and returns the file content as a `Blob` */
  blob(): Promise<Blob>;
  /** Downloads and returns the file content as a `Uint8Array` */
  bytes(): Promise<Uint8Array>;

  /** Writes content to the file, replacing any existing content */
  write(content: WriteContent, options?: WriteOptions): Promise<void>;

  /** Copies this file to `path` within the same bucket */
  copyTo(path: string): Promise<void>;
  /** Moves this file to `path` (copy + delete original) */
  moveTo(path: string): Promise<void>;
  /**
   * Renames the file within its current directory.
   * Throws if `name` contains a `/`, use `moveTo()` to change directories.
   */
  rename(name: string): Promise<void>;
  /** Deletes the file. Aliases: `unlink()`, `delete()` */
  remove(): Promise<void>;
  /** Alias of `remove()` (Bun `S3File.unlink()`) */
  unlink(): Promise<void>;

  /** Returns a web `ReadableStream` of the file content */
  stream(): ReadableStream;
  /** Returns a Node.js `ReadableStream` of the file content */
  nodeReadable(): NodeJS.ReadableStream;
  /** Returns a web `WritableStream` that writes to this file */
  writable(options?: WriteOptions): WritableStream;
  /** Returns a Node.js `WritableStream` that writes to this file */
  nodeWritable(options?: WriteOptions): NodeJS.WritableStream;

  /** Returns the permanent public URL, or `null` if not publicly accessible */
  publicUrl(): string | null;
  /** Returns a time-limited signed URL for downloading the file */
  signedUrl(opts: { expires: number | string }): Promise<string | null>;
  /** Returns a time-limited signed URL for uploading to this file path */
  uploadUrl(opts: { expires: number | string }): Promise<string | null>;
  /**
   * Bun-style presigned URL (matches `Bun.s3` `.presign()`). Delegates to
   * `uploadUrl()` for `method: "PUT"`/`"POST"`, otherwise `signedUrl()`.
   * Accepts `expiresIn` (seconds, Bun-style) or `expires` (number or duration string).
   */
  presign(opts?: {
    method?: string;
    expiresIn?: number;
    expires?: number | string;
  }): Promise<string | null>;
}

/** A bucket (or container) that holds files */
export interface IBucket {
  /** Provider type (e.g. "S3", "GCS", "AZURE") */
  type?: string;

  /** Returns metadata about the bucket */
  info(): Promise<BucketInfo>;
  /**
   * Lists all files in the bucket.
   * Pass a string for prefix filtering, or a `RegExp` for pattern filtering.
   */
  list(filter?: RegExp | string): Promise<IBucketFile[]>;
  /**
   * Deletes all files matching the optional filter.
   * Returns the deleted file objects.
   */
  remove(filter?: RegExp | string): Promise<IBucketFile[]>;
  /** Returns the number of files matching the optional filter */
  count(filter?: RegExp | string): Promise<number>;
  /** Returns a file handle for the given path (does not check existence) */
  file(name: string): IBucketFile;
  /** Iterates over all files in the bucket */
  [Symbol.asyncIterator](): AsyncIterator<IBucketFile>;
}

export interface S3Auth {
  id: string;
  secret: string;
  region: string;
  sessionToken?: string;
}

export interface S3Request {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string | Buffer;
  params?: Record<string, string | undefined>;
  [key: string]: unknown;
}
