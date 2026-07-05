# Bucket [![bucket](https://img.shields.io/npm/v/bucket?label=bucket&color=greenlime)](https://www.npmjs.com/package/bucket) [![tests](https://github.com/franciscop/bucket/workflows/tests/badge.svg)](https://github.com/franciscop/bucket/actions)

A small library to talk to any of the popular file storage solutions with a unified API:

```js
import BackBlaze from "bucket/b2"; // or /s3, /r2, /fs, etc

const bucket = BackBlaze("bucket-name", { id, secret });

const file = bucket.file("demo.txt");
await file.write("hello world");
console.log(await file.text());
```

It has different engines and they all behave the same. It also has a "filesystem" Bucket, which will treat a local folder as a bucket:

```js
// More complex example with streams and pipes
import FileSystem from "bucket/fs";
import BackBlaze from "bucket/b2";

const fs = FileSystem("./public/");
const b2 = BackBlaze("mybucketname", { id, secret });

const source = fs.file("local.txt").stream();
const target = b2.file("newfile.txt").writable();
await source.pipeTo(target);
```

## API

There are two main APIs, the `Bucket` one and the `BucketFile` one:

- `Bucket()` initialize the instance attached to a single bucket.
  - `.info()`: display the information about the current bucket.
  - `.list(filter?)`: return the list of all files in the bucket.
  - `.scan(filter?)`: async generator that lazily yields files (streams pages).
  - `.count(filter?)`: return the Number of items in the bucket.
  - `.remove(filter?)`: delete all files matching the filter, returning them.
  - `.file(path)`: creates a BucketFile instance for the given path
  - `.folder(path)`: a Bucket scoped to a path prefix (see below).
- `BucketFile` instance (created with `.file()`, or each item in the `list()`). It has `id`, `name` and `path` already:
  - `.info()`: returns some more details of the file, like `date` (creation time), `type` (mime type) and `size`.
  - `.exists()`: checks whether a file exists, returning true if it does.
  - `.text()`: read the contents of the file as a string
  - `.json()`: read the contents of the file as parsed JSON
  - `.arrayBuffer()`: read the contents of the file as an ArrayBuffer
  - `.blob()`: read the contents of the file as a Blob
  - `.bytes()`: read the contents of the file as a Uint8Array
  - `.slice(start, end?)`: a read-only view of a byte range (like `Blob.slice()`); every read method above honours it. See [file.slice()](#fileslice).
  - `.write(body, options?)`: writes content to the file. Accepts strings, Buffers, Blobs, streams, or another file object. Content-type is auto-detected from the file extension; pass `options` to override it or set `cacheControl`, `disposition`, and `metadata`.
  - `.copyTo(path)`: creates a duplicate of a file with a different name (keeping the original).
  - `.moveTo(path)`: change the location of the file (removing the original).
  - `.rename(name)`: change the name of the file enforcing it remains in the same folder (removing the original).
  - `.remove()`: deletes the file completely (alias: `.unlink()`).
  - `.stream()`: returns a web `ReadableStream` that can be piped to a writable stream.
  - `.nodeReadable()`: returns a Node.js `Readable` stream for use with `pipeline()` etc.
  - `.writable()`: returns a web `WritableStream` that can receive data from a readable stream.
  - `.nodeWritable()`: returns a Node.js `Writable` stream for use with `pipeline()` etc.
  - `.publicUrl()`: the permanent public URL of the file (or `null`).
  - `.signedUrl(opts)` / `.uploadUrl(opts)`: a time-limited download / upload URL.
  - `.presign(opts?)`: Bun-style alias of the two above (`.uploadUrl()` for `{ method: "PUT" }`, otherwise `.signedUrl()`).

### Bucket()

Each service exports a `Bucket` class. The first argument is always the bucket name; the second is a config object with credentials.

```js
import S3 from "bucket/s3";

const bucket = S3("my-bucket-name", {
  id: "access-key-id",
  secret: "secret-access-key",
  region: "us-east-1",
});
```

All credential fields fall back to environment variables, so in most setups you can omit the config entirely:

```js
// Reads AWS_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION from process.env
const bucket = S3();
```

See the [Services](#services) section for the env var names and options for each provider.

### bucket.info()

Returns `Promise<BucketInfo>` with basic information about the bucket:

```js
const info = await bucket.info();
// {
//   id: "access-key-id",
//   name: "my-bucket-name",
//   type: "S3",
//   url: "https://my-bucket-name.s3.us-east-1.amazonaws.com"
// }
```

### bucket.list()

Returns `Promise<BucketFile[]>` with all files in the bucket. Accepts an optional `RegExp` to filter by pattern; to scope to a path prefix, use [`.folder()`](#bucketfolder).

```js
const all = await bucket.list();
const images = await bucket.list(/\.jpe?g$/);
const logs = await bucket.folder("logs").list(); // everything under logs/
```

You can also iterate the bucket directly with `for await`, which streams pages lazily and stops fetching if you `break`:

```js
for await (const file of bucket) {
  if (file.name.endsWith(".txt")) {
    console.log(await file.text());
  }
}
```

### bucket.scan()

Returns an async generator that yields files, fetching provider pages as they're consumed instead of buffering the whole listing. Unlike the bare `for await (const f of bucket)` form it accepts an optional `RegExp` filter, so you can filter while streaming, which is ideal for very large buckets or when you may stop early:

```js
for await (const file of bucket.scan(/\.log$/)) {
  if (await shouldStop(file)) break; // no further pages are fetched
}
```

`list()` is simply `scan()` collected into an array, and `for await (const f of bucket)` delegates to it.

### bucket.count()

Returns `Promise<number>` with the total number of files. Accepts the same filter as `.list()`.

```js
const total = await bucket.count();
const images = await bucket.count(/\.jpe?g$/);
```

### bucket.remove()

Deletes every file matching the optional `RegExp` and returns the deleted `BucketFile` objects; with no filter it empties the bucket (or the folder, when called on one). On S3 and R2 the deletion is batched into as few requests as possible.

```js
await bucket.remove(/\.tmp$/); // delete every .tmp file
const deleted = await bucket.folder("cache").remove(); // delete everything under cache/
console.log(`removed ${deleted.length} files`);
```

### bucket.file()

Returns a `BucketFile` handle for the given path. It mirrors the `Blob` read API (`.text()`, `.json()`, `.arrayBuffer()`, `.bytes()`, `.blob()`, `.stream()`), but it is a **lazy remote handle, not a `Blob` itself**, so to hand it to `FormData`, `Response`, or `fetch`, materialize it first with `await file.blob()` (buffered) or `file.stream()` (streaming). See [Guides](#guides). This is a synchronous operation. It does not make any network requests or check whether the file exists.

```js
const file = bucket.file("photos/avatar.jpg");
console.log(await file.text()); // or .json(), or .stream(), etc
```

The returned object has three properties set immediately:

- `id`: a unique identifier for the file (the path for S3/R2/B2, a hash for the filesystem)
- `name`: the filename without the directory, e.g. `"avatar.jpg"`
- `path`: the full path within the bucket, e.g. `"photos/avatar.jpg"`

### bucket.folder()

Returns a `Bucket` scoped to a path prefix. It behaves like any other bucket, but every operation is confined to that folder: `.file()` resolves names inside it, and `.list()`, `.count()`, `.remove()`, and iteration only see files within it. Folders nest, and the prefix is normalized (`"./public/"` and `"public"` are equivalent). This is synchronous and makes no network requests.

```js
const assets = bucket.folder("public");
await assets.file("favicon.ico").write(icon); // stored at "public/favicon.ico"
const styles = await assets.folder("css").list(); // only files under "public/css/"
```

File paths stay absolute, relative to the bucket root, so `assets.file("favicon.ico").path` is `"public/favicon.ico"`. A `RegExp` passed to a folder's `.list()` is matched against the path below the folder, so `assets.list(/^favicon/)` matches `public/favicon.ico`.

### file.info()

Returns a `Promise<FileInfo>` with metadata about the file:

```js
const info = await bucket.file("photo.jpg").info();
// {
//   id: "photo.jpg",
//   name: "photo.jpg",
//   path: "photo.jpg",
//   exists: true,
//   type: "image/jpeg",
//   size: 175888,
//   date: Date,
//   url: "https://...",  // null for local filesystem
//   metadata: {}         // custom metadata, lowercase keys
// }
```

If the file does not exist, `exists` is `false`, `type` is `null`, `size` is `0`, `date`/`url` are `null`, and `metadata` is `{}`.

The `url` field is the file's public URL when it exists (the canonical address; whether it is actually reachable depends on the bucket or object being public). It is `null` for the local filesystem, and `null` when the file does not exist.

The `metadata` field holds the custom key-value metadata set with `write(..., { metadata })`. Keys are normalized to lowercase on both write and read so they round-trip consistently. The local filesystem has no metadata store, so it always returns `{}`.

### file.exists()

Returns `Promise<boolean>`. Shorthand for `(await file.info()).exists`.

```js
const photo = bucket.file("photo.jpg");
if (await photo.exists()) { ... }
```

### file.text()

Returns `Promise<string>` with the full contents of the file decoded as UTF-8. Matches the `Blob`/`Response` API.

```js
const content = await bucket.file("readme.txt").text();
```

### file.json()

Returns `Promise<unknown>` with the file contents parsed as JSON. Matches the `Blob`/`Response` API.

```js
const data = await bucket.file("config.json").json();
```

### file.arrayBuffer()

Returns `Promise<ArrayBuffer>` with the raw binary contents. Works in any runtime (see [Which runtimes are supported?](#which-runtimes-are-supported)). Matches the `Blob`/`Response` API.

```js
const buf = await bucket.file("photo.jpg").arrayBuffer();
// Node.js: Buffer.from(buf)
// Everywhere: new Uint8Array(buf)
```

### file.blob()

Returns `Promise<Blob>` with the file contents as a `Blob`. Useful for passing to `FormData`, `Response`, or browser APIs.

```js
const blob = await bucket.file("photo.jpg").blob();
const formData = new FormData();
formData.append("photo", blob, "photo.jpg");
```

### file.bytes()

Returns `Promise<Uint8Array>` with the raw binary contents as a typed array. Works in any runtime. Matches the `Blob`/`Response` API.

```js
const bytes = await bucket.file("photo.jpg").bytes();
```

### file.slice()

Returns a **read-only view of a byte range**, synchronously, like [`Blob.slice()`](https://developer.mozilla.org/docs/Web/API/Blob/slice): `end` is exclusive and defaults to the end of the file. It returns a `BucketFile`, so every read method (`.text()`, `.bytes()`, `.arrayBuffer()`, `.blob()`, `.stream()`, `.nodeReadable()`) reads only that range. Remote providers translate it to an HTTP `Range` request; the filesystem reads only those bytes. Ranges are clamped to the file size and compose (`file.slice(0, 100).slice(10, 20)`).

```js
const head = await bucket.file("big.csv").slice(0, 1024).bytes(); // first 1 KiB
const rest = bucket.file("big.csv").slice(1024).stream(); // from 1 KiB to EOF
```

`info().size` on a slice reports the **clamped slice length** (the bytes this view yields), while every other field (`type`, `date`, `exists`, `url`) still describes the underlying file:

```js
(await bucket.file("data.txt").slice(0, 4).info()).size; // 4
```

This makes range serving a one-liner, e.g. answering an HTTP `Range` request:

```js
const [start, end] = parseRange(req.headers.get("range")); // inclusive
const { size, type } = await file.info();
return new Response(file.slice(start, end + 1).stream(), {
  status: 206,
  headers: {
    "Content-Type": type,
    "Content-Range": `bytes ${start}-${end}/${size}`,
    "Content-Length": String(end - start + 1),
  },
});
```

### file.write(body, options?)

Writes content to the file. If the file already exists it is overwritten. Intermediate directories are created automatically. Accepts:

- `string`
- `Buffer` / `Uint8Array`
- `Blob`
- `ReadableStream` (web)
- `Readable` (Node.js)
- Another `BucketFile` instance (copies the content)

```js
await bucket.file("hello.txt").write("hello world");
await bucket.file("data.bin").write(new Uint8Array([1, 2, 3]));
await bucket.file("copy.txt").write(bucket.file("original.txt"));
```

**Content-type** is inferred automatically from the file extension (e.g. `.jpg` → `image/jpeg`, `.json` → `application/json`). You can override it and set other metadata through the optional second argument:

| Option         | Type                     | Description                                                                |
| -------------- | ------------------------ | -------------------------------------------------------------------------- |
| `type`         | `string`                 | MIME type (overrides auto-detection)                                       |
| `cacheControl` | `string`                 | `Cache-Control` header value, e.g. `"public, max-age=31536000"`            |
| `disposition`  | `string`                 | `Content-Disposition` header value, e.g. `"attachment; filename=file.pdf"` |
| `metadata`     | `Record<string, string>` | Provider-specific key/value metadata                                       |

```js
await bucket.file("image.jpg").write(data, {
  type: "image/jpeg",
  cacheControl: "public, max-age=31536000",
  disposition: "inline",
  metadata: { author: "alice" },
});
```

> **Note:** Options are silently ignored by the FileSystem provider.

### file.copyTo(path)

Creates a duplicate of the file at a new path, keeping the original:

```js
await bucket.file("photo.jpg").copyTo("backup/photo.jpg");
```

### file.moveTo(path)

Moves the file to a new path, removing the original:

```js
await bucket.file("tmp/upload.jpg").moveTo("photos/avatar.jpg");
```

### file.rename(name)

Renames the file within the same directory. Throws if `name` contains a `/`, use `.moveTo()` to change directories.

```js
await bucket.file("photos/old-name.jpg").rename("new-name.jpg");
```

### file.remove()

Deletes the file.

```js
await bucket.file("temp.txt").remove();
```

### file.stream()

Returns a web `ReadableStream<Uint8Array>` synchronously. Works in any runtime. Matches `Blob.stream()`.

```js
const stream = bucket.file("video.mp4").stream();
return new Response(stream); // e.g. stream it straight to an HTTP response
```

### file.nodeReadable()

Returns a Node.js `Readable` stream. Use this with Node.js `pipeline()` or any library that expects a Node stream.

```js
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

await pipeline(
  bucket.file("data.csv").nodeReadable(),
  createGzip(),
  bucket.file("data.csv.gz").nodeWritable(),
);
```

### file.writable()

Returns a web `WritableStream<Uint8Array>` synchronously. Use with `.pipeTo()`.

```js
const stream = bucket.file("output.txt").writable();
await readableStream.pipeTo(stream);
```

### file.nodeWritable()

Returns a Node.js `Writable` stream. Use with Node.js `pipeline()` or any library that writes to a Node stream.

```js
import { pipeline } from "node:stream/promises";

await pipeline(
  bucket.file("input.txt").nodeReadable(),
  bucket.file("output.txt").nodeWritable(),
);
```

## Services

All services share the same API. The only difference is how you initialize the bucket. The small differences are noted in each section, please familiarize yourself with the ones you use:

### Filesystem FS

Treats a local folder as a bucket. Useful for development, testing, or when you just want a consistent file API over local disk.

```js
import FileSystem from "bucket/fs";

const bucket = FileSystem("./my-folder");
```

The path is resolved relative to the current working directory. No credentials needed.

### Backblaze B2

```js
import BackBlaze from "bucket/b2";

const bucket = BackBlaze("my-bucket-name", {
  id: "...", // Application Key ID
  secret: "...", // Application Key
});
```

Environment variable fallbacks:

| Option      | Env var                 |
| ----------- | ----------------------- |
| bucket name | `B2_BUCKET`             |
| `id`        | `B2_APPLICATION_KEY_ID` |
| `secret`    | `B2_APPLICATION_KEY`    |

### AWS S3

S3 is the default export of the package, so `import bucket from "bucket"` is equivalent to `import S3 from "bucket/s3"`.

```js
import S3 from "bucket/s3";

const bucket = S3("my-bucket-name", {
  id: "...", // Access Key ID
  secret: "...", // Secret Access Key
  region: "us-east-1", // defaults to us-east-1
  url: "...", // optional: override the endpoint URL
});
```

Environment variable fallbacks:

| Option      | Env var                 |
| ----------- | ----------------------- |
| bucket name | `AWS_BUCKET`            |
| `id`        | `AWS_ACCESS_KEY_ID`     |
| `secret`    | `AWS_SECRET_ACCESS_KEY` |
| `region`    | `AWS_REGION`            |
| `url`       | `AWS_URL`               |

The `url` option lets you point at any S3-compatible service (MinIO, DigitalOcean Spaces, etc.).

### Cloudflare R2

```js
import R2 from "bucket/r2";

const bucket = R2("my-bucket", {
  id: "...", // Access Key ID
  secret: "...", // Secret Access Key
  url: "https://<account>.r2.cloudflarestorage.com/my-bucket",
});
```

The `url` is the full R2 endpoint URL, including the bucket name at the end; it must match the bucket `name` passed as the first argument.

Environment variable fallbacks:

| Option      | Env var                |
| ----------- | ---------------------- |
| bucket name | `R2_BUCKET`            |
| `url`       | `R2_URL`               |
| `id`        | `R2_ACCESS_KEY_ID`     |
| `secret`    | `R2_SECRET_ACCESS_KEY` |

### Google Cloud Storage

```js
import GCS from "bucket/gcs";

const bucket = GCS("my-bucket");
```

Credentials are resolved automatically, in order:

1. `GOOGLE_APPLICATION_CREDENTIALS` (path to a service-account JSON file)
2. `GCS_CLIENT_EMAIL` + `GCS_PRIVATE_KEY`
3. The GCP metadata server (Cloud Run, GKE, Compute Engine)

| Option        | Env var                          |
| ------------- | -------------------------------- |
| bucket name   | `GCS_BUCKET`                     |
| service email | `GCS_CLIENT_EMAIL`               |
| private key   | `GCS_PRIVATE_KEY`                |
| credentials   | `GOOGLE_APPLICATION_CREDENTIALS` |

Pass `{ url, anonymous }` (or set `GCS_URL` / `GCS_ANONYMOUS`) to point at an emulator such as fake-gcs-server:

```js
const bucket = GCS("my-bucket", {
  url: "http://localhost:4443",
  anonymous: true,
});
```

### Azure Blob Storage

```js
import Azure from "bucket/azure";

const bucket = Azure("my-container", {
  account: "my-account",
  key: "base64-account-key",
});
```

You can also pass a full connection string, or omit the key to use Managed Identity on Azure-hosted infrastructure:

```js
// Connection string (its BlobEndpoint is honoured automatically)
const bucket = Azure("my-container", {
  connectionString:
    "DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;",
});

// Managed Identity, no key needed
const bucket = Azure("my-container", { account: "my-account" });
```

| Option             | Env var                   |
| ------------------ | ------------------------- |
| container name     | `AZURE_CONTAINER`         |
| `account`          | `AZURE_ACCOUNT`           |
| `key`              | `AZURE_KEY`               |
| `url`              | `AZURE_URL`               |
| `connectionString` | `AZURE_CONNECTION_STRING` |

The `url` option points at the Azurite emulator or a custom/sovereign cloud, e.g. `http://127.0.0.1:10000/devstoreaccount1`.

### More?

Open an [issue or PR](https://github.com/franciscop/bucket) if you'd like to see another service supported.

## Guides

A `BucketFile` is a **lazy remote handle, not a `Blob`**. It exposes the same read methods as a `Blob`, but to hand it to a Web API materialize it first:

- **`file.stream()`**: a web `ReadableStream`, for streaming bodies (no buffering).
- **`await file.blob()`**: a real `Blob`, for APIs that need one (`FormData`).

> Passing the `BucketFile` object _itself_ to `new Response(file)` or `FormData.append(name, file)` will **not** work: it is not a `Blob`, and would serialize as empty. Always use `.stream()` or `.blob()`.

### Serve over HTTP

```js
// Bun.serve, Next.js, Hono, or any fetch handler
export default {
  fetch(req) {
    return new Response(bucket.file("video.mp4").stream(), {
      headers: { "content-type": "video/mp4" },
    });
  },
};
```

### Attach to `FormData`

```js
const form = new FormData();
const file = bucket.file("avatar.png");
form.append("avatar", await file.blob(), file.name);

await fetch("https://api.example.com/upload", { method: "POST", body: form });
```

### Streaming with fetch()

```js
await fetch("https://api.example.com/ingest", {
  method: "PUT",
  body: bucket.file("big.csv").stream(),
  duplex: "half", // required when the body is a stream
});
```

### Store fetch() file

```js
// Buffered
const res = await fetch("https://example.com/image.png");
await bucket.file("image.png").write(await res.blob());

// Or streamed, without holding it all in memory
await res.body.pipeTo(bucket.file("image.png").writable());

// Straight from an inbound upload in a server handler
async fetch(req) {
  await bucket.file("upload.bin").write(req.body); // req.body is a ReadableStream
  return new Response("ok");
}
```

### Combine buckets

`write()` accepts a `BucketFile` from **any** provider, so moving data between services is one call:

```js
import S3 from "bucket/s3";
import FileSystem from "bucket/fs";

const s3 = S3("my-bucket");
const fs = FileSystem("./downloads");

await fs.file("report.pdf").write(s3.file("report.pdf")); // download S3 → disk
await s3.file("report.pdf").write(fs.file("report.pdf")); // upload disk → S3

// Or stream between them without buffering
await s3.file("a.bin").stream().pipeTo(fs.file("a.bin").writable());
```

**Direction:** `dst.write(src)` is a _pull_, so the file you call it on is the destination and it reads from the argument. To _push_ within a single bucket, use the source-side `src.copyTo(dst)` or `src.moveTo(dst)` instead. Cross-provider copies always use the pull form above, since `copyTo` / `moveTo` stay inside one bucket.

### Bun's File

A `Bun.file()` is a `Blob`, so it drops straight into `write()`, and a bucket file's `.blob()` drops into `Bun.write()`:

```js
// Local file → bucket
await bucket.file("photo.jpg").write(Bun.file("./local/photo.jpg"));

// Bucket → local file
await Bun.write("./local/photo.jpg", await bucket.file("photo.jpg").blob());
```

### Resize with sharp

```js
import { pipeline } from "node:stream/promises";
import sharp from "sharp";

await pipeline(
  bucket.file("original.jpg").nodeReadable(),
  sharp().resize(200, 200),
  bucket.file("thumbnail.jpg").nodeWritable(),
);
```

### Resize with `Bun.Image`

Bun ships a native image processor, [`Bun.Image`](https://bun.sh/docs/api/image), with no dependencies. It reads `Uint8Array` / `Buffer` / `ArrayBuffer` / `Blob` and outputs the same, so it plugs straight into a bucket file: read the bytes, transform, then write the result back.

```js
const src = bucket.file("photos/original.jpg");

// Read the file into Bun.Image
const img = new Bun.Image(await src.bytes());
const { width, height, format } = await img.metadata();

// Resize and re-encode, then hand the bytes back to the bucket
const thumb = await img.resize(200, 200).webp().toBuffer();
await bucket.file("photos/thumb.webp").write(thumb, { type: "image/webp" });
```

The transforms are chainable (`.resize()`, `.rotate()`, `.flip()`, `.flop()`, `.modulate()`), followed by a format (`.png()`, `.jpeg()`, `.webp()`, `.avif()`, `.heic()`) and an output (`.toBuffer()`, `.bytes()`, `.blob()`). Because both sides speak bytes, this works across providers too. For example, resize an upload sitting on S3 and store the thumbnail on R2:

```js
const buf = await new Bun.Image(await s3.file("a.jpg").bytes())
  .resize(800)
  .jpeg()
  .toBuffer();
await r2.file("thumbnails/a.jpg").write(buf, { type: "image/jpeg" });
```

A few things to know:

- Read the dimensions from `await img.metadata()`. The sync `.width` / `.height` getters report `-1` until the image has been decoded.
- `Bun.Image` buffers the whole image, so read with `.bytes()`, not `.stream()`.
- It is Bun only. On Node or other runtimes use `sharp`, which streams and pipes through `.nodeReadable()` / `.nodeWritable()` directly (see [Resize with sharp](#resize-with-sharp) above).

**TypeScript:** `Bun.Image` is not in `@types/bun` yet, so the compiler reports `Property 'Image' does not exist`. Add a small ambient declaration until the types ship:

```ts
// bun-image.d.ts
declare namespace Bun {
  class Image {
    constructor(input: Uint8Array | ArrayBuffer | Buffer | Blob);
    metadata(): Promise<{ width: number; height: number; format: string }>;
    resize(width: number, height?: number): Bun.Image;
    rotate(deg: number): Bun.Image;
    flip(): Bun.Image;
    flop(): Bun.Image;
    modulate(o: {
      brightness?: number;
      saturation?: number;
      hue?: number;
    }): Bun.Image;
    png(): Bun.Image;
    jpeg(): Bun.Image;
    webp(): Bun.Image;
    avif(): Bun.Image;
    heic(): Bun.Image;
    toBuffer(): Promise<Buffer>;
    bytes(): Promise<Uint8Array>;
    blob(): Promise<Blob>;
  }
}
```

### Zip files

```js
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

await pipeline(
  bucket.file("data.csv").nodeReadable(),
  createGzip(),
  bucket.file("data.csv.gz").nodeWritable(),
);
```

## FAQ

### Does this library ship TypeScript types?

Yes. The library is written in TypeScript and ships types for all methods. No `@types/` package needed.

```ts
import S3 from "bucket/s3";
import type { Bucket, BucketFile, FileInfo } from "bucket/s3";

const bucket: Bucket = S3("my-bucket");
const file: BucketFile = bucket.file("photo.jpg");
const info: FileInfo = await file.info();
```

### Which runtimes are supported?

Node, Bun, Deno, browsers, and Cloudflare Workers. Request signing uses **WebCrypto** (`crypto.subtle`), and reads/writes use the Web `fetch`, `Blob`, and Streams APIs, so there is no `node:crypto` dependency. The only Node-specific imports are `node:stream` (used solely by the optional `.nodeReadable()` / `.nodeWritable()` helpers) and `node:fs` / `node:os` (the FileSystem provider only).

On Cloudflare Workers, use a remote provider with the web helpers (`.stream()`, `.writable()`); enable the `nodejs_compat` flag if you also want the `.nodeReadable()` / `.nodeWritable()` helpers.

### What happens when a file doesn't exist?

`.info()` and `.exists()` never throw: they return `exists: false` and `false` respectively. All other read methods (`.text()`, `.json()`, `.arrayBuffer()`, etc.) will throw if the file doesn't exist.

### What happens on a network or auth error?

Methods throw a `BucketError` (a subclass of `Error`). Alongside the human-readable `message` it carries structured fields you can branch on:

- `code`: a normalized, uppercase string, one of `"NOT_FOUND" | "FORBIDDEN" | "UNAUTHORIZED" | "CONFLICT" | "UNKNOWN"`. It means the same thing across every provider, including the filesystem.
- `status`: the raw HTTP status, when the failure came from an HTTP response (absent for the filesystem).
- `provider`: which backend produced it (e.g. `"S3"`).

There is no automatic retry.

```js
import { BucketError } from "bucket";

try {
  const text = await bucket.file("data.txt").text();
} catch (err) {
  if (err instanceof BucketError && err.code === "NOT_FOUND") {
    // handle a missing file
  }
}
```

### What are "web streams" vs "node streams"?

When Node.js was created, there was no native streaming in JavaScript. So Node.js built its own streaming system, now known as "Node streams". A few years later, the JavaScript standards body created an official streaming API, first shipped in browsers alongside `fetch()`, now known as "web streams".

The two are not directly compatible. Which one you need depends on what you're connecting to:

- If you're piping to/from a web API (`fetch`, `Response`, `Request`): use web streams (`.stream()`, `.writable()`)
- If you're using a Node.js library like `sharp`, `zlib`, `csv-parse`: use Node streams (`.nodeReadable()`, `.nodeWritable()`)

```js
// Web streams: pipe directly into a fetch response body
const stream = bucket.file("video.mp4").stream();
return new Response(stream);

// Node streams: pipe through sharp (which uses Node streams)
import { pipeline } from "node:stream/promises";
import sharp from "sharp";

await pipeline(
  bucket.file("photo.jpg").nodeReadable(),
  sharp().resize(300),
  bucket.file("thumb.jpg").nodeWritable(),
);
```

## Testing

```bash
bun test                 # mocked suites, signer oracles, FileSystem (no network)
EXPENSIVE=true bun test  # also the cloud providers, when credentials are present
```

The test suite has three layers, the first two of which need **no credentials**:

1. **Mocked unit tests** (`*/index.test.ts`): exercise each provider's request/response handling with a stubbed `fetch`.
2. **Signer oracle tests** (`lib/*.test.ts`): prove the request signing is correct without hitting any service:
   - S3/R2 AWS Signature V4 is cross-checked against [`aws4`](https://www.npmjs.com/package/aws4) (the reference signer): identical signature, byte for byte.
   - GCS V4 signatures are verified cryptographically against the public key.
3. **Integration tests** (`test/index.test.ts`): the full API against a real backend. FileSystem always runs; the cloud providers (S3, R2, GCS, Azure, B2) are opt-in and run only with `EXPENSIVE=true` set, plus their credentials (or an emulator endpoint). A plain `bun test` stays local and makes no network calls.

### Emulators

S3, R2, GCS and Azure can be tested end-to-end against local emulators, no Docker required. MinIO and Azurite **validate request signatures**, so a green run proves the signer against a real server.

The emulators run as native binaries. Azurite ships as a devDependency (installed by `bun install`); MinIO (S3 + R2) and fake-gcs-server (GCS) are standalone binaries that need to be on your `PATH`:

```bash
brew install minio fake-gcs-server   # macOS; see each project's docs for other OSes
```

Then a single command starts all three, seeds the buckets, runs the suite, and tears everything down:

```bash
npm run test:emulators
```

Configuration lives in [`.env.emulators`](.env.emulators) (well-known emulator defaults, no secrets). To run against one provider only, start the emulators yourself and filter with `BUCKET`:

```bash
npx azurite-blob --silent --location /tmp/azurite &
bun run emulators:setup
BUCKET=Azure bun --env-file=.env.emulators test test/index.test.ts
```

### Real credentials

Copy `.env.sample` to `.env` and fill in the providers you want to exercise, then opt in with `EXPENSIVE=true`; the buckets whose credentials are present are picked up automatically.

```bash
EXPENSIVE=true bun test
```
