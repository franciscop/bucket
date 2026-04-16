# Bucket [![test badge](https://github.com/franciscop/bucket/workflows/tests/badge.svg "test badge")](https://github.com/franciscop/bucket/blob/master/.github/workflows/tests.yml)

A small library to talk to any of the popular file storage solutions with a unified API:

```js
// Default import is a ready-to-use S3 bucket (reads AWS_BUCKET, AWS_ACCESS_KEY_ID, etc. from env)
import bucket from "bucket";

const file = bucket.file("demo.txt");
await file.write("hello world");
console.log(await file.text());
```

Or import a specific provider:

```js
import BackBlaze from "bucket/b2"; // or /s3, /r2, /fs, etc

const bucket = BackBlaze("bucket-name", { id, key });
```

It has different engines and they all behave the same. It also has a "filesystem" Bucket, which will treat a local folder as a bucket:

```js
// More complex example with streams and pipes
import FileSystem from "bucket/fs";
import BackBlaze from "bucket/b2";

const fs = FileSystem("./public/");
const b2 = BackBlaze("mybucketname", { id, key });

// Zip all of the local files and upload those zips to B2
const source = fs.file("local.txt").stream();
const target = b2.file("newfile.txt").writable();
await source.pipeTo(target);
```

## API

There are two main APIs, the `Bucket` one and the `File` one:

- `Bucket()` initialize the instance attached to a single bucket.
  - `.info()`: display the information about the current bucket.
  - `.list(filter?)`: return the list of all files in the bucket.
  - `.count(filter?)`: return the Number of items in the bucket.
  - `.file(path)`: creates a File instance for the given path
- `File` instance (created with `.file()`, or each item in the `list()`). It has `id`, `name` and `path` already:
  - `.info()`: returns some more details of the file, like `date` (creation time), `type` (mime type) and `size`.
  - `.exists()`: checks whether a file exists, returning true if it does.
  - `.text()`: read the contents of the file as a string
  - `.json()`: read the contents of the file as parsed JSON
  - `.arrayBuffer()`: read the contents of the file as an ArrayBuffer
  - `.blob()`: read the contents of the file as a Blob
  - `.bytes()`: read the contents of the file as a Uint8Array
  - `.write(body, options?)`: writes content to the file. Accepts strings, Buffers, Blobs, streams, or another file object. Content-type is auto-detected from the file extension; pass `options` to override it or set `cacheControl`, `disposition`, and `metadata`.
  - `.copyTo(path)`: creates a duplicate of a file with a different name (keeping the original).
  - `.moveTo(path)`: change the location of the file (removing the original).
  - `.rename(name)`: change the name of the file enforcing it remains in the same folder (removing the original).
  - `.remove()`: deletes the file completely.
  - `.stream()`: returns a web `ReadableStream` that can be piped to a writable stream.
  - `.nodeReadable()`: returns a Node.js `Readable` stream for use with `pipeline()` etc.
  - `.writable()`: returns a web `WritableStream` that can receive data from a readable stream.
  - `.nodeWritable()`: returns a Node.js `Writable` stream for use with `pipeline()` etc.

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
//   endpoint: "https://my-bucket-name.s3.us-east-1.amazonaws.com"
// }
```

### bucket.list()

Returns `Promise<File[]>` with all files in the bucket. Accepts an optional filter:

```js
const all = await bucket.list();
const images = await bucket.list(/\.jpe?g$/);
const logs = await bucket.list("logs/"); // prefix match
```

You can instead iterate through files lazily with `for await`:

```js
for await (const file of bucket) {
  if (file.name.endsWith(".txt")) {
    console.log(await file.text());
  }
}
```

### bucket.count()

Returns `Promise<number>` with the total number of files. Accepts the same filter as `.list()`.

```js
const total = await bucket.count();
const images = await bucket.count(/\.jpe?g$/);
```

### bucket.file()

Returns a `File` instance for the given path, which is a subclass of `Blob`/`Response`. This is a synchronous operation — it does not make any network requests or check whether the file exists.

```js
const file = bucket.file("photos/avatar.jpg");
console.log(await file.text()); // or .json(), or .stream(), etc
```

The returned object has three properties set immediately:

- `id` — a unique identifier for the file (the path for S3/R2/B2, a hash for the filesystem)
- `name` — the filename without the directory, e.g. `"avatar.jpg"`
- `path` — the full path within the bucket, e.g. `"photos/avatar.jpg"`

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
//   url: "https://..."   // null for local filesystem
// }
```

If the file does not exist, `exists` is `false`, `type` is `null`, `size` is `0`, and `date`/`url` are `null`.

The `url` field is only populated when the file is publicly accessible — remote buckets return the public URL if the file is public, `null` otherwise. The local filesystem always returns `null`.

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

Returns `Promise<ArrayBuffer>` with the raw binary contents. Works in all environments including Cloudflare Workers. Matches the `Blob`/`Response` API.

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

Returns `Promise<Uint8Array>` with the raw binary contents as a typed array. Works in all environments. Matches the `Blob`/`Response` API.

```js
const bytes = await bucket.file("photo.jpg").bytes();
```

### file.write(body, options?)

Writes content to the file. If the file already exists it is overwritten. Intermediate directories are created automatically. Accepts:

- `string`
- `Buffer` / `Uint8Array`
- `Blob`
- `ReadableStream` (web)
- `Readable` (Node.js)
- Another `File` instance (copies the content)

```js
await bucket.file("hello.txt").write("hello world");
await bucket.file("data.bin").write(new Uint8Array([1, 2, 3]));
await bucket.file("copy.txt").write(bucket.file("original.txt"));
```

**Content-type** is inferred automatically from the file extension (e.g. `.jpg` → `image/jpeg`, `.json` → `application/json`). You can override it and set other metadata through the optional second argument:

| Option | Type | Description |
|---|---|---|
| `type` | `string` | MIME type (overrides auto-detection) |
| `cacheControl` | `string` | `Cache-Control` header value, e.g. `"public, max-age=31536000"` |
| `disposition` | `string` | `Content-Disposition` header value, e.g. `"attachment; filename=file.pdf"` |
| `metadata` | `Record<string, string>` | Provider-specific key/value metadata |

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

Renames the file within the same directory. Throws if `name` contains a `/` — use `.moveTo()` to change directories.

```js
await bucket.file("photos/old-name.jpg").rename("new-name.jpg");
```

### file.remove()

Deletes the file.

```js
await bucket.file("temp.txt").remove();
```

### file.stream()

Returns a web `ReadableStream<Uint8Array>` synchronously. Works in all environments. Matches `Blob.stream()`.

```js
const stream = bucket.file("video.mp4").stream();
await stream.pipeTo(response.body);
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

| Option      | Env var                   |
| ----------- | ------------------------- |
| bucket name | `B2_BUCKET`               |
| `id`        | `B2_APPLICATION_KEY_ID`   |
| `secret`    | `B2_APPLICATION_KEY`      |

### AWS S3

S3 is the default export of the package, so `import bucket from "bucket"` is equivalent to `import S3 from "bucket/s3"`.

```js
import S3 from "bucket/s3";

const bucket = S3("my-bucket-name", {
  id: "...", // Access Key ID
  key: "...", // Secret Access Key
  region: "us-east-1", // defaults to us-east-1
  endpoint: "...", // optional: override endpoint URL
});
```

Environment variable fallbacks:

| Option      | Env var                   |
| ----------- | ------------------------- |
| bucket name | `AWS_BUCKET`              |
| `id`        | `AWS_ACCESS_KEY_ID`       |
| `secret`    | `AWS_SECRET_ACCESS_KEY`   |
| `region`    | `AWS_REGION`              |
| `endpoint`  | `AWS_ENDPOINT`            |

The `endpoint` option lets you point at any S3-compatible service (MinIO, DigitalOcean Spaces, etc.).

### Cloudflare R2

```js
import R2 from "bucket/r2";

const bucket = R2("my-bucket-name", {
  id: "...", // Access Key ID
  secret: "...", // Secret Access Key
});
```

Environment variable fallbacks:

| Option     | Env var               |
| ---------- | --------------------- |
| bucket URL | `R2_ENDPOINT`         |
| `id`       | `R2_ACCESS_KEY_ID`    |
| `secret`   | `R2_SECRET_ACCESS_KEY`|

### More?

Open an issue or PR if you'd like to see another service supported.

## Advanced

### Pipes introduction

This tutorial focuses on best practices around pipes and streaming. A pipe is an operation that moves data from a source to a destination, with optionally some transformation operations in the middle. It's useful to **keep the memory consumption low** when working with large files and **to perform transformation operations** to files.

The simplest example I can think is copying a file; read the original one and copying everything to the destination path:

```js
// The native operation
await bucket.file("/myfile.txt").copyTo("/copied.txt");

// Similar to the above but using streams (for demonstration purposes):
const source = bucket.file("/myfile.txt").stream();
const target = bucket.file("/copied.txt").writable();
await source.pipeTo(target);

// If we knew the files are small, we could do this instead:
const data = await bucket.file("/myfile.txt").text();
await bucket.file("/copied.txt").write(data);
```

Something you might've noticed is that we don't know when the pipe finishes executing, for that we can use the helper `pipeline()` from Node.js that makes the operation awaitable:

```js
import { pipeline } from "node:stream/promises";

// Same as above but awaitable, using Node.js streams:
await pipeline(
  bucket.file("/myfile.txt").nodeReadable(),
  bucket.file("/copied.txt").nodeWritable(),
);
```

Let's say we want to resize an image with `sharp`, then we can pipe through a transform as well:

```js
import { pipeline } from "node:stream/promises";
import sharp from "sharp";

const srcImg = bucket.file("/myimg.png").nodeReadable();
const resize = sharp().resize(200, 200);
const dstImg = bucket.file("/preview/myimg.png").nodeWritable();

// Perform the operation while creating a new file and not wasting memory
await pipeline(srcImg, resize, dstImg);
```

## Examples

### Uploading and downloading local files

There's no dedicated `.upload()` / `.download()` method — instead, use the `FileSystem` bucket as one side of the transfer:

```js
import S3 from "bucket/s3";
import FileSystem from "bucket/fs";

const s3 = S3("my-bucket");
const fs = FileSystem("./exports");

// upload
await s3.file("report.pdf").write(fs.file("report.pdf"));

// download
await fs.file("report.pdf").write(s3.file("report.pdf"));
```

### Zip and upload files

```js
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

await pipeline(
  bucket.file("data.csv").nodeReadable(),
  createGzip(),
  bucket.file("data.csv.gz").nodeWritable(),
);
```

### Resize and upload images

```js
import { pipeline } from "node:stream/promises";
import sharp from "sharp";

await pipeline(
  bucket.file("original.jpg").nodeReadable(),
  sharp().resize(200, 200),
  bucket.file("thumbnail.jpg").nodeWritable(),
);
```

## FAQ

### Does this library ship TypeScript types?

Yes. The library is written in TypeScript and ships types for all methods. No `@types/` package needed.

```ts
import S3 from "bucket/s3";
import type { FileInfo, BucketInfo } from "bucket/s3";

const bucket = S3("my-bucket");
const info: FileInfo = await bucket.file("photo.jpg").info();
```

### What happens when a file doesn't exist?

`.info()` and `.exists()` never throw — they return `exists: false` and `false` respectively. All other read methods (`.text()`, `.json()`, `.arrayBuffer()`, etc.) will throw if the file doesn't exist.

### What happens on a network or auth error?

Methods throw a `Error` with a message containing the HTTP status code, e.g. `"S3 GET error: 403"`. There is no automatic retry — wrap calls in try/catch if you need to handle errors gracefully:

```js
try {
  const text = await bucket.file("data.txt").text();
} catch (err) {
  console.error("Failed to read file:", err.message);
}
```

### What are "web streams" vs "node streams"?

When Node.js was created, there was no native streaming in JavaScript. So Node.js built its own streaming system, now known as "Node streams". A few years later, the JavaScript standards body created an official streaming API, first shipped in browsers alongside `fetch()` — now known as "web streams".

The two are not directly compatible. Which one you need depends on what you're connecting to:

- If you're piping to/from a web API (`fetch`, `Response`, `Request`) — use web streams (`.stream()`, `.writable()`)
- If you're using a Node.js library like `sharp`, `zlib`, `csv-parse` — use Node streams (`.nodeReadable()`, `.nodeWritable()`)

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
