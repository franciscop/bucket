type BucketErrorCode = "NOT_FOUND" | "FORBIDDEN" | "UNAUTHORIZED" | "CONFLICT" | "INVALID_PATH" | "INVALID_FILTER" | "INVALID_CONFIG" | "INVALID_CONTENT" | "ABORTED" | "UNKNOWN";
interface BucketErrorOptions {
    /** Provider that produced the error, e.g. "S3", "GCS", "FILESYSTEM".
     * Absent for errors raised before reaching a provider (the INVALID_* codes
     * and ABORTED). */
    provider?: string;
    /** Raw HTTP status, when the error came from an HTTP response */
    status?: number;
    /** Normalized code; derived from `status` when omitted */
    code?: BucketErrorCode;
    /** The underlying error or response that caused this */
    cause?: unknown;
}
declare class BucketError extends Error {
    readonly provider?: string;
    readonly status?: number;
    readonly code: BucketErrorCode;
    constructor(message: string, options: BucketErrorOptions);
}

/** Options accepted by every method that performs I/O. */
interface ReadOptions {
    /** Aborts the operation. Rejects with a `BucketError` of code `"ABORTED"`. */
    signal?: AbortSignal;
}

interface ChunkedTarget<Ctx, Part> {
    /** Bytes to accumulate before escalating to a chunked upload. A function
     * for providers that only learn it at runtime (B2's auth response). */
    partSize: number | (() => Promise<number>);
    /** One-request upload, used when the whole body fits in a single part. */
    single(data: Buffer): Promise<void>;
    /** Open a chunked-upload session. Only called once a second part exists. */
    start(): Promise<Ctx>;
    /** Upload one part. `n` is 1-indexed; `isLast` marks the final part. */
    part(ctx: Ctx, n: number, data: Buffer, isLast: boolean): Promise<Part>;
    /** Assemble the uploaded parts into the final object. */
    finish(ctx: Ctx, parts: Part[]): Promise<void>;
    /** Discard the session and any uploaded parts. */
    abort(ctx: Ctx): Promise<void>;
}

interface ByteRange {
    start: number;
    end?: number;
}

/** Metadata returned by `file.info()`; `info()` resolves to `null` when the
 * file does not exist, so every field here is always real. */
interface FileInfo {
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
interface BucketInfo {
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
type WriteContent = string | Buffer | Uint8Array | Blob | BucketFile | ReadableStream | NodeJS.ReadableStream;

interface WriteOptions extends ReadOptions {
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
interface BucketFile {
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
    signedUrl(opts: {
        expires: number | string;
    }): Promise<string | null>;
    /** Returns a time-limited signed URL for uploading to this file path */
    uploadUrl(opts: {
        expires: number | string;
    }): Promise<string | null>;
}
/** A bucket (or container) that holds files */
interface Bucket {
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
interface S3Auth {
    id: string;
    secret: string;
    region: string;
    sessionToken?: string;
}

interface WriteMeta {
    /** Resolved MIME type, or null when the extension is unknown. */
    type: string | null;
    cacheControl?: string;
    disposition?: string;
    /** Custom metadata, keys lowercased: every provider sends them as headers,
     * which are case-insensitive, so the casing would not survive a round trip. */
    metadata: Record<string, string>;
}

/** What every provider's context carries, whatever else it adds. */
interface FileContext {
    /** Label for error messages and `BucketError.provider`. */
    provider: string;
    /** Folder prefix of the bucket this handle came from. */
    prefix: string;
    /** Configured public origin; "" when unset. */
    publicUrl: string;
}
declare abstract class BaseFile<Ctx extends FileContext = FileContext> implements BucketFile {
    #private;
    name: string;
    path: string;
    protected readonly ctx: Ctx;
    protected range: ByteRange | null;
    constructor(path: string, ctx: Ctx);
    /** Range-aware, status-checked GET. The empty-range shortcut is handled
     * by the base, so `this.range` here is never empty. */
    protected abstract fetch(opts?: ReadOptions): Promise<Response>;
    /** One-request upload of a whole body. */
    protected abstract put(data: Buffer, options: WriteOptions): Promise<void>;
    /** The provider's chunked-upload mechanism; the base runs the machine. */
    protected abstract target(options: WriteOptions): ChunkedTarget<unknown, unknown>;
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
    protected get provider(): string;
    /** A fresh handle for another key in the same bucket scope. */
    protected at(path: string): this;
    /** Throws a BucketError unless the response is ok or in `also`. */
    protected check(res: Response, what: string, ...also: number[]): Response;
    /** The write options, resolved into the shape every provider maps from. */
    protected meta(options: WriteOptions, content?: Blob): WriteMeta;
    slice(start: number, end?: number): this;
    protected get(opts?: ReadOptions): Promise<Response>;
    exists(opts?: ReadOptions): Promise<boolean>;
    text(opts?: ReadOptions): Promise<string>;
    json(opts?: ReadOptions): Promise<unknown>;
    arrayBuffer(opts?: ReadOptions): Promise<ArrayBuffer>;
    blob(opts?: ReadOptions): Promise<Blob>;
    bytes(opts?: ReadOptions): Promise<Uint8Array>;
    write(content: WriteContent, options?: WriteOptions): Promise<this>;
    private dispatch;
    copyTo(dest: string | BucketFile, opts?: ReadOptions): Promise<BucketFile>;
    remove(opts?: ReadOptions): Promise<this>;
    moveTo(dest: string | BucketFile, opts?: ReadOptions): Promise<BucketFile>;
    rename(name: string, opts?: ReadOptions): Promise<BucketFile>;
    unlink(opts?: ReadOptions): Promise<this>;
    stream(opts?: ReadOptions): ReadableStream;
    nodeReadable(opts?: ReadOptions): NodeJS.ReadableStream;
    writable(options?: WriteOptions): WritableStream;
    nodeWritable(options?: WriteOptions): NodeJS.WritableStream;
    publicUrl(): Promise<string | null>;
}
declare abstract class BaseBucket<Ctx extends FileContext, F extends BaseFile<Ctx>> implements Bucket {
    abstract readonly type: string;
    protected readonly ctx: Ctx;
    constructor(ctx: Ctx);
    /** Yields the bucket's files a provider page at a time, already scoped to
     * the folder and filter. */
    protected abstract pages(filter?: RegExp, opts?: ReadOptions): AsyncGenerator<F[]>;
    /** A handle for an already-resolved key. */
    protected abstract make(key: string): F;
    abstract info(opts?: ReadOptions): Promise<BucketInfo>;
    get PREFIX(): string;
    /** Throws a BucketError unless the response is ok or in `also`. */
    protected check(res: Response, what: string, ...also: number[]): Response;
    file(name: string): F;
    folder(path: string): this;
    /** Deletes the listed files, returning the ones confirmed gone. Overridden
     * where the provider has a batch delete. */
    protected removeAll(files: F[], opts?: ReadOptions): Promise<F[]>;
    scan(filter?: RegExp, opts?: ReadOptions): AsyncGenerator<F>;
    private iterate;
    list(filter?: RegExp, opts?: ReadOptions): Promise<F[]>;
    count(filter?: RegExp, opts?: ReadOptions): Promise<number>;
    remove(filter: RegExp, opts?: ReadOptions): Promise<F[]>;
    create(content: WriteContent, options?: WriteOptions): Promise<F>;
    [Symbol.asyncIterator](): AsyncGenerator<F>;
}

interface FSContext extends FileContext {
    root: string;
}
declare class FSFile extends BaseFile<FSContext> {
    #private;
    protected fetch(opts?: ReadOptions): Promise<Response>;
    info(opts?: ReadOptions): Promise<FileInfo | null>;
    protected put(data: Buffer, options: WriteOptions): Promise<void>;
    protected target(options: WriteOptions): ChunkedTarget<never, never>;
    copyTo(dest: string | BucketFile, opts?: ReadOptions): Promise<BucketFile>;
    protected copy(key: string): Promise<void>;
    moveTo(dest: string | BucketFile, opts?: ReadOptions): Promise<BucketFile>;
    protected delete(): Promise<void>;
    protected canonicalUrl(): Promise<null>;
    signedUrl(_opts: {
        expires: number | string;
    }): Promise<null>;
    uploadUrl(_opts: {
        expires: number | string;
    }): Promise<null>;
    stream(opts?: ReadOptions): ReadableStream;
    nodeReadable(opts?: ReadOptions): NodeJS.ReadableStream;
    writable(_options?: WriteOptions): WritableStream;
}

interface FSConfig {
    /** Public origin the directory is served from, e.g. a static mount like
     * `http://localhost:3000/static` (falls back to `FS_PUBLIC_URL`). Used by
     * `file.publicUrl()`, which returns null without it. */
    publicUrl?: string;
}
declare class FileSystemBucket extends BaseBucket<FSContext, FSFile> {
    readonly type = "FILESYSTEM";
    get path(): string;
    protected make(key: string): FSFile;
    file(name: string): FSFile;
    folder(path: string): this;
    info(opts?: ReadOptions): Promise<BucketInfo>;
    protected pages(filter?: RegExp): AsyncGenerator<FSFile[], void, unknown>;
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
 * @param config.publicUrl - Public origin for `file.publicUrl()` (falls back to `FS_PUBLIC_URL`)
 *
 * @example
 * const bucket = FileSystem("./uploads");
 * await bucket.file("hello.txt").write("hello");
 */
declare function FileSystem(path: string, config?: FSConfig): FileSystemBucket;

interface HttpRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string | Buffer;
}
/** Fills in a request's auth. May rewrite headers or the url (query signing). */
type Authorizer = (req: HttpRequest) => Promise<HttpRequest> | HttpRequest;
interface SendOptions {
    headers?: Record<string, string>;
    body?: string | Buffer;
    signal?: AbortSignal;
    /** Statuses to accept besides 2xx, e.g. 404 on a delete. */
    ok?: number[];
    /** Label for the error message, e.g. "GET" or "list". */
    what?: string;
    /** Return the response whatever the status, leaving the check to the caller. */
    raw?: boolean;
    /** false sends the request as given: no authorizer and no 401 refresh, for
     * a request that carries its own credential (a B2 upload URL). */
    auth?: boolean;
}
interface HttpOptions {
    /** Label used in error messages and `BucketError.provider`. */
    provider: string;
    authorize: Authorizer;
    /** Extra attempts after a retriable failure. 0 disables retrying. */
    retries?: number;
    /** Called once when an authorized request comes back 401, before it is
     * authorized again and retried. For credentials that expire (a B2 session). */
    refresh?: (req: HttpRequest) => Promise<void>;
}
declare class Http {
    #private;
    constructor(opts: HttpOptions);
    get(url: string, options?: SendOptions): Promise<Response>;
    head(url: string, options?: SendOptions): Promise<Response>;
    put(url: string, options?: SendOptions): Promise<Response>;
    post(url: string, options?: SendOptions): Promise<Response>;
    delete(url: string, options?: SendOptions): Promise<Response>;
    /** Sends one authorized request, retrying transient failures. The verb
     * methods above are the usual entry; this is for a method held in a variable. */
    send(method: string, url: string, options?: SendOptions): Promise<Response>;
}

declare class TokenCache<T> {
    #private;
    /** `resolve` returns the credential and the epoch millis it expires at. */
    constructor(resolve: () => Promise<[T, number]>);
    get(): Promise<T>;
}

interface S3LikeConfig {
    /** "S3" or "R2": the `type` of the bucket and the label in errors. */
    type: string;
    name: string;
    region: string;
    /** Endpoint without the bucket; "" means AWS's virtual-hosted default. */
    endpoint: string;
    publicUrl: string;
    /** Static credentials, or null to resolve them lazily (instance metadata). */
    auth: S3Auth | null;
    /** Credentials resolver used when `auth` is null. */
    resolveAuth?: (region: string) => Promise<S3Auth & {
        expiry: number;
    }>;
    /** Whether the storage endpoint is publicly readable (S3 yes, R2 never). */
    canonicalPublic: boolean;
}
interface S3Context extends FileContext {
    config: S3LikeConfig;
    /** Endpoint with the bucket appended: the base every request is built on. */
    url: string;
    auth: TokenCache<S3Auth>;
    http: Http;
}
declare class S3LikeBucket extends BaseBucket<S3Context, S3LikeFile> {
    readonly type: string;
    constructor(ctx: S3Context);
    protected make(key: string): S3LikeFile;
    info(opts?: ReadOptions): Promise<BucketInfo>;
    protected pages(filter?: RegExp, opts?: ReadOptions): AsyncGenerator<S3LikeFile[], void, unknown>;
    protected removeAll(files: S3LikeFile[], opts?: ReadOptions): Promise<S3LikeFile[]>;
}
declare class S3LikeFile extends BaseFile<S3Context> {
    #private;
    protected fetch(opts?: ReadOptions): Promise<Response>;
    info(opts?: ReadOptions): Promise<FileInfo | null>;
    protected put(data: Buffer, options: WriteOptions): Promise<void>;
    protected target(options: WriteOptions): ChunkedTarget<string, string>;
    protected copy(key: string, opts?: ReadOptions): Promise<void>;
    protected delete(opts?: ReadOptions): Promise<void>;
    protected canonicalUrl(): Promise<string | null>;
    signedUrl(opts: {
        expires: number | string;
    }): Promise<string>;
    uploadUrl(opts: {
        expires: number | string;
    }): Promise<string>;
}

interface S3Config {
    id?: string;
    secret?: string;
    region?: string;
    sessionToken?: string;
    /** Endpoint *without* the bucket, e.g. `http://127.0.0.1:9000` for MinIO
     * (falls back to `AWS_ENDPOINT_URL`). The bucket name is appended as a path
     * segment. Unset, the virtual-hosted AWS endpoint is used instead. */
    url?: string;
    /** Public origin the bucket is served from, e.g. a CloudFront domain (falls
     * back to `AWS_PUBLIC_URL`). Used by `file.publicUrl()`. */
    publicUrl?: string;
}
/**
 * Create an AWS S3 bucket handle.
 *
 * @param bucket - Bucket name (falls back to `AWS_BUCKET` env var)
 * @param config.id - Access Key ID (falls back to `AWS_ACCESS_KEY_ID`)
 * @param config.secret - Secret Access Key (falls back to `AWS_SECRET_ACCESS_KEY`)
 * @param config.sessionToken - Session token for temporary credentials (falls back to `AWS_SESSION_TOKEN`)
 * @param config.region - AWS region, default `"us-east-1"` (falls back to `AWS_REGION`)
 * @param config.url - Endpoint without the bucket, which gets appended (falls back to `AWS_ENDPOINT_URL`)
 * @param config.publicUrl - Public origin for `file.publicUrl()` (falls back to `AWS_PUBLIC_URL`)
 *
 * When `id` and `secret` are not provided, credentials are resolved automatically
 * from the environment: ECS/Lambda container credentials or EC2 instance metadata.
 *
 * @example
 * const bucket = S3("my-bucket", { id: "keyId", secret: "secretKey", region: "us-west-2" });
 * await bucket.file("hello.txt").write("hello");
 */
declare function S3(bucket?: string, { id, secret, region, url, publicUrl, sessionToken, }?: S3Config): S3LikeBucket;

interface R2Config {
    id?: string;
    secret?: string;
    region?: string;
    sessionToken?: string;
    /** Cloudflare account id, which the endpoint is derived from (falls back
     * to `R2_ACCOUNT_ID`). This is the normal way to configure R2. */
    account?: string;
    /** Endpoint *without* the bucket, for custom endpoints and emulators (falls
     * back to `R2_URL`). The bucket name is appended as a path segment.
     * Derived from `account` when unset. */
    url?: string;
    /** Public base for `file.publicUrl()`: the bucket's `r2.dev` or custom
     * domain, e.g. `https://cdn.example.com` (falls back to `R2_PUBLIC_URL`).
     * Without it `publicUrl()` returns null, since R2's storage endpoint is
     * never publicly readable. */
    publicUrl?: string;
}
/**
 * Create a Cloudflare R2 bucket handle.
 *
 * @param name - Bucket name (falls back to `R2_BUCKET` env var)
 * @param config.id - Access Key ID (falls back to `R2_ACCESS_KEY_ID`)
 * @param config.secret - Secret Access Key (falls back to `R2_SECRET_ACCESS_KEY`)
 * @param config.sessionToken - Session token for temporary credentials (falls back to `R2_SESSION_TOKEN`)
 * @param config.region - Region, default `"auto"` (falls back to `R2_REGION`)
 * @param config.account - Cloudflare account id the endpoint is derived from (falls back to `R2_ACCOUNT_ID`)
 * @param config.url - Endpoint without the bucket, for custom endpoints (falls back to `R2_URL`)
 * @param config.publicUrl - Public origin for `file.publicUrl()` (falls back to `R2_PUBLIC_URL`)
 *
 * @example
 * const bucket = CloudflareR2("my-bucket", {
 *   id: "keyId",
 *   secret: "secretKey",
 *   account: "abc123",
 * });
 * await bucket.file("hello.txt").write("hello");
 */
declare function CloudflareR2(name?: string, { id, secret, region, sessionToken, account, url, publicUrl, }?: R2Config): S3LikeBucket;

type GCSAuth = {
    clientEmail: string;
    privateKey: string;
} | null;
interface GCSContext extends FileContext {
    bucket: string;
    auth: Promise<GCSAuth>;
    url: string;
    anonymous: boolean;
    http: Http;
}
declare class GCSFile extends BaseFile<GCSContext> {
    #private;
    protected fetch(opts?: ReadOptions): Promise<Response>;
    info(opts?: ReadOptions): Promise<FileInfo | null>;
    protected put(data: Buffer, options: WriteOptions): Promise<void>;
    protected target(options: WriteOptions): ChunkedTarget<{
        uri: string;
        offset: number;
    }, number>;
    protected copy(key: string, opts?: ReadOptions): Promise<void>;
    protected delete(opts?: ReadOptions): Promise<void>;
    protected canonicalUrl(): Promise<string>;
    signedUrl(opts: {
        expires: number | string;
    }): Promise<string | null>;
    uploadUrl(opts: {
        expires: number | string;
    }): Promise<string | null>;
}

interface GCSConfig {
    /** Override the API host (falls back to `GCS_URL`). Use for the
     * fake-gcs-server emulator, e.g. `http://localhost:4443`. */
    url?: string;
    /** Skip authentication entirely, required by emulators that don't verify
     * tokens (falls back to `GCS_ANONYMOUS=true`). */
    anonymous?: boolean;
    /** Public origin the bucket is served from, e.g. a CDN domain (falls back
     * to `GCS_PUBLIC_URL`). Used by `file.publicUrl()`. */
    publicUrl?: string;
}
declare class GCSBucket extends BaseBucket<GCSContext, GCSFile> {
    readonly type = "GCS";
    protected make(key: string): GCSFile;
    info(opts?: ReadOptions): Promise<BucketInfo>;
    protected pages(filter?: RegExp, opts?: ReadOptions): AsyncGenerator<GCSFile[], void, unknown>;
}
/**
 * Create a Google Cloud Storage bucket handle.
 *
 * Credentials are resolved in this order:
 * 1. `GOOGLE_APPLICATION_CREDENTIALS` env var → reads the JSON file it points to
 * 2. `GCS_CLIENT_EMAIL` + `GCS_PRIVATE_KEY` env vars
 * 3. GCP metadata server (Cloud Run, GKE, Compute Engine)
 *
 * @param bucket - Bucket name (falls back to `GCS_BUCKET` env var)
 * @param config.url - Override the API host (falls back to `GCS_URL`)
 * @param config.anonymous - Skip authentication, for emulators (falls back to `GCS_ANONYMOUS`)
 * @param config.publicUrl - Public origin for `file.publicUrl()` (falls back to `GCS_PUBLIC_URL`)
 *
 * @example
 * const bucket = GCS("my-bucket");
 * await bucket.file("hello.txt").write("hello");
 */
declare function GCS(bucket?: string, config?: GCSConfig): GCSBucket;

type AzureFileAuth = {
    type: "shared-key";
    key: string;
} | {
    type: "managed-identity";
    getToken: () => Promise<string>;
};
interface AzureContext extends FileContext {
    account: string;
    container: string;
    url: string;
    auth: AzureFileAuth;
    http: Http;
}
declare class AzureFile extends BaseFile<AzureContext> {
    #private;
    protected fetch(opts?: ReadOptions): Promise<Response>;
    info(opts?: ReadOptions): Promise<FileInfo | null>;
    protected put(data: Buffer, options: WriteOptions): Promise<void>;
    protected target(options: WriteOptions): ChunkedTarget<string[], string>;
    protected copy(key: string, opts?: ReadOptions): Promise<void>;
    protected delete(opts?: ReadOptions): Promise<void>;
    protected canonicalUrl(): Promise<string>;
    signedUrl(opts: {
        expires: number | string;
    }): Promise<string | null>;
    uploadUrl(opts: {
        expires: number | string;
    }): Promise<string | null>;
}

interface AzureConfig {
    /** Storage account name (falls back to `AZURE_ACCOUNT`) */
    account?: string;
    /** Base64-encoded storage account key (falls back to `AZURE_KEY`).
     * Omit to use Managed Identity (Azure VMs, App Service, Container Apps, etc.) */
    key?: string;
    /** Override the blob host (falls back to `AZURE_URL`). Use for the Azurite
     * emulator or sovereign clouds, e.g. `http://127.0.0.1:10000/devstoreaccount1`. */
    url?: string;
    /** Full Azure connection string (falls back to `AZURE_CONNECTION_STRING`).
     * When present, its account, key, and BlobEndpoint are used. */
    connectionString?: string;
    /** Public origin the container is served from, e.g. a Front Door domain
     * (falls back to `AZURE_PUBLIC_URL`). Used by `file.publicUrl()`. */
    publicUrl?: string;
}
declare class AzureBucket extends BaseBucket<AzureContext, AzureFile> {
    readonly type = "AZURE";
    protected make(key: string): AzureFile;
    info(opts?: ReadOptions): Promise<BucketInfo>;
    protected pages(filter?: RegExp, opts?: ReadOptions): AsyncGenerator<AzureFile[], void, unknown>;
}
/**
 * Create an Azure Blob Storage container handle.
 *
 * @param container - Container name (falls back to `AZURE_CONTAINER` env var)
 * @param config.account - Storage account name (falls back to `AZURE_ACCOUNT`)
 * @param config.key - Base64-encoded storage account key (falls back to `AZURE_KEY`).
 *   Omit to use Managed Identity (Azure VMs, App Service, Container Apps, etc.)
 * @param config.url - Override the blob host (falls back to `AZURE_URL`). Use for
 *   the Azurite emulator or sovereign clouds, e.g.
 *   `http://127.0.0.1:10000/devstoreaccount1`.
 * @param config.connectionString - Full Azure connection string (falls back to
 *   `AZURE_CONNECTION_STRING`). Its account, key, and BlobEndpoint are used.
 * @param config.publicUrl - Public origin for `file.publicUrl()` (falls back to `AZURE_PUBLIC_URL`)
 *
 * @example
 * const bucket = Azure("mycontainer", { account: "myaccount", key: "base64key==" });
 */
declare function Azure(container?: string, config?: AzureConfig): AzureBucket;

interface B2Auth {
    bucketId: string;
    bucketName: string;
    token: string;
    apiBase: string;
    /** Download origin, with a trailing slash. */
    base: string;
    absoluteMinimumPartSize: number;
}
declare class B2Session {
    #private;
    constructor(id: string, secret: string, name: string);
    get(): Promise<B2Auth>;
    /** Re-authorizes because `token` was rejected as expired. Only the first
     * caller with the current token re-authorizes; every other one, and any
     * later caller still holding an old token, awaits that same replacement. */
    refresh(token: string): Promise<void>;
}

interface B2Context extends FileContext {
    session: B2Session;
    http: Http;
}
declare class B2File extends BaseFile<B2Context> {
    #private;
    protected fetch(opts?: ReadOptions): Promise<Response>;
    info(opts?: ReadOptions): Promise<FileInfo | null>;
    protected put(data: Buffer, options: WriteOptions): Promise<void>;
    protected target(options: WriteOptions): ChunkedTarget<{
        fileId: string;
    }, string>;
    protected copy(key: string, opts?: ReadOptions): Promise<void>;
    protected delete(opts?: ReadOptions): Promise<void>;
    protected canonicalUrl(): Promise<string>;
    signedUrl(opts: {
        expires: number | string;
    }): Promise<string>;
    uploadUrl(_opts: {
        expires: number | string;
    }): Promise<null>;
}

interface B2Config {
    id?: string;
    secret?: string;
    /** Public origin the bucket is served from, e.g. a CDN in front of B2 (falls
     * back to `B2_PUBLIC_URL`). Used by `file.publicUrl()`. */
    publicUrl?: string;
}
declare class BackBlazeInstance extends BaseBucket<B2Context, B2File> {
    readonly type = "BACKBLAZE";
    protected make(key: string): B2File;
    info(opts?: ReadOptions): Promise<BucketInfo>;
    protected pages(filter?: RegExp, opts?: ReadOptions): AsyncGenerator<B2File[], void, unknown>;
}
/**
 * Create a Backblaze B2 bucket handle.
 *
 * @param name - Bucket name (falls back to `B2_BUCKET` env var)
 * @param opts.id - Application Key ID (falls back to `B2_APPLICATION_KEY_ID`)
 * @param opts.secret - Application Key (falls back to `B2_APPLICATION_KEY`)
 * @param opts.publicUrl - Public origin for `file.publicUrl()` (falls back to `B2_PUBLIC_URL`)
 *
 * @example
 * const bucket = BackBlaze("my-bucket", { id: "keyId", secret: "appKey" });
 * await bucket.file("hello.txt").write("hello");
 */
declare function BackBlaze(name?: string, { id, secret, publicUrl, }?: B2Config): BackBlazeInstance;

/** What the Map holds: the bytes plus everything write() was told about them. */
interface MemoryEntry {
    data: Buffer;
    type: string | null;
    modified: Date;
    cacheControl?: string;
    disposition?: string;
    metadata: Record<string, string>;
}
interface MemoryContext extends FileContext {
    /** The one Map behind the bucket, shared with every folder of it. */
    files: Map<string, MemoryEntry>;
    name: string;
}
declare class MemoryFile extends BaseFile<MemoryContext> {
    #private;
    protected fetch(): Promise<Response>;
    info(opts?: ReadOptions): Promise<FileInfo | null>;
    protected put(data: Buffer, options: WriteOptions): Promise<void>;
    protected target(options: WriteOptions): ChunkedTarget<never, never>;
    protected copy(key: string): Promise<void>;
    protected delete(): Promise<void>;
    protected canonicalUrl(): Promise<null>;
    signedUrl(_opts: {
        expires: number | string;
    }): Promise<null>;
    uploadUrl(_opts: {
        expires: number | string;
    }): Promise<null>;
}

interface MemoryConfig {
    /** Public origin to pretend the bucket is served from (falls back to
     * `MEMORY_PUBLIC_URL`). Used by `file.publicUrl()`, which returns null
     * without it. Nothing actually serves these bytes. */
    publicUrl?: string;
}
declare class MemoryBucket extends BaseBucket<MemoryContext, MemoryFile> {
    readonly type = "MEMORY";
    protected make(key: string): MemoryFile;
    info(opts?: ReadOptions): Promise<BucketInfo>;
    protected pages(filter?: RegExp): AsyncGenerator<MemoryFile[], void, unknown>;
}
/**
 * Create an in-memory bucket handle, backed by a Map.
 *
 * Built for tests: fast, no disk, nothing to clean up, and isolated per
 * instance (two `Memory()` calls are two separate buckets). The data dies with
 * the process. It is not a cache and not a scratch bucket; do not use it in
 * production.
 *
 * It is the one provider that ignores nothing a write is given: `type`,
 * `metadata`, `cacheControl` and `disposition` all round-trip through
 * `info()`, so it is the provider to develop against when you use metadata.
 *
 * @param name - Bucket name, only used by `info()` (default `"memory"`)
 * @param config.publicUrl - Public origin for `file.publicUrl()` (falls back to `MEMORY_PUBLIC_URL`)
 *
 * @example
 * const bucket = Memory();
 * await bucket.file("hello.txt").write("hello");
 */
declare function Memory(name?: string, config?: MemoryConfig): MemoryBucket;

declare const mimes: Record<string, string>;

declare const _default: {
    FS: typeof FileSystem;
    S3: typeof S3;
    R2: typeof CloudflareR2;
    GCS: typeof GCS;
    Azure: typeof Azure;
    B2: typeof BackBlaze;
    Memory: typeof Memory;
};

export { Azure, BackBlaze as B2, BackBlaze, type Bucket, BucketError, type BucketErrorCode, type BucketFile, type BucketInfo, CloudflareR2, FileSystem as FS, type FileInfo, FileSystem, GCS, Memory, CloudflareR2 as R2, type ReadOptions, S3, type WriteContent, type WriteOptions, _default as default, mimes };
