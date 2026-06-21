# Bucket [![bucket](https://img.shields.io/npm/v/bucket?label=bucket&color=greenlime)](https://www.npmjs.com/package/bucket) [![tests](https://github.com/franciscop/bucket/workflows/tests/badge.svg)](https://github.com/franciscop/bucket/actions)

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

const bucket = BackBlaze("bucket-name", { id, secret });
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

Returns a `File` handle for the given path. It mirrors the `Blob` read API (`.text()`, `.json()`, `.arrayBuffer()`, `.bytes()`, `.blob()`, `.stream()`), but it is a **lazy remote handle, not a `Blob` itself**, so to hand it to `FormData`, `Response`, or `fetch`, materialize it first with `await file.blob()` (buffered) or `file.stream()` (streaming). See [Combining with other APIs](#combining-with-other-apis). This is a synchronous operation. It does not make any network requests or check whether the file exists.

```js
const file = bucket.file("photos/avatar.jpg");
console.log(await file.text()); // or .json(), or .stream(), etc
```

The returned object has three properties set immediately:

- `id`: a unique identifier for the file (the path for S3/R2/B2, a hash for the filesystem)
- `name`: the filename without the directory, e.g. `"avatar.jpg"`
- `path`: the full path within the bucket, e.g. `"photos/avatar.jpg"`

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

The `url` field is the file's public URL when it exists (the canonical address; whether it is actually reachable depends on the bucket or object being public). It is `null` for the local filesystem, and `null` when the file does not exist.

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
  endpoint: "...", // optional: override endpoint URL
});
```

Environment variable fallbacks:

| Option      | Env var                 |
| ----------- | ----------------------- |
| bucket name | `AWS_BUCKET`            |
| `id`        | `AWS_ACCESS_KEY_ID`     |
| `secret`    | `AWS_SECRET_ACCESS_KEY` |
| `region`    | `AWS_REGION`            |
| `endpoint`  | `AWS_ENDPOINT`          |

The `endpoint` option lets you point at any S3-compatible service (MinIO, DigitalOcean Spaces, etc.).

### Cloudflare R2

```js
import R2 from "bucket/r2";

const bucket = R2("https://<account>.r2.cloudflarestorage.com/my-bucket", {
  id: "...", // Access Key ID
  secret: "...", // Secret Access Key
});
```

The first argument is the full R2 endpoint URL, including the bucket name at the end.

Environment variable fallbacks:

| Option     | Env var                |
| ---------- | ---------------------- |
| bucket URL | `R2_ENDPOINT`          |
| `id`       | `R2_ACCESS_KEY_ID`     |
| `secret`   | `R2_SECRET_ACCESS_KEY` |

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

Pass `{ endpoint, anonymous }` (or set `GCS_ENDPOINT` / `GCS_ANONYMOUS`) to point at an emulator such as fake-gcs-server:

```js
const bucket = GCS("my-bucket", {
  endpoint: "http://localhost:4443",
  anonymous: true,
});
```

### Azure Blob Storage

```js
import Azure from "bucket/azure";

const bucket = Azure("my-account", "my-container", "base64-account-key");
```

You can also pass a full connection string, or omit the key to use Managed Identity on Azure-hosted infrastructure:

```js
// Connection string (its BlobEndpoint is honoured automatically)
const bucket = Azure(
  "DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;",
);

// Managed Identity, no key needed
const bucket = Azure("my-account", "my-container");
```

| Option     | Env var           |
| ---------- | ----------------- |
| account    | `AZURE_ACCOUNT`   |
| container  | `AZURE_CONTAINER` |
| `key`      | `AZURE_KEY`       |
| `endpoint` | `AZURE_ENDPOINT`  |

The `endpoint` option (4th argument, `{ endpoint }`) points at the Azurite emulator or a custom/sovereign cloud, e.g. `http://127.0.0.1:10000/devstoreaccount1`.

### More?

Open an issue or PR if you'd like to see another service supported.

## Combining with other APIs

A `File` is a **lazy remote handle, not a `Blob`**. It exposes the same read methods as a `Blob`, but to hand it to a Web API materialize it first:

- **`file.stream()`**: a web `ReadableStream`, for streaming bodies (no buffering).
- **`await file.blob()`**: a real `Blob`, for APIs that need one (`FormData`).

> Passing the `File` object _itself_ to `new Response(file)` or `FormData.append(name, file)` will **not** work: it is not a `Blob`, and would serialize as empty. Always use `.stream()` or `.blob()`.

### Serve a file over HTTP

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

### Attach a file to `FormData`

```js
const form = new FormData();
const file = bucket.file("avatar.png");
form.append("avatar", await file.blob(), file.name);

await fetch("https://api.example.com/upload", { method: "POST", body: form });
```

### Stream a file into an outbound request

```js
await fetch("https://api.example.com/ingest", {
  method: "PUT",
  body: bucket.file("big.csv").stream(),
  duplex: "half", // required when the body is a stream
});
```

### Store an incoming request / response body

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

### Combine buckets (copy across providers)

`write()` accepts a `File` from **any** provider, so moving data between services is one call:

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

### Combine with Bun's file APIs

A `Bun.file()` is a `Blob`, so it drops straight into `write()`, and a bucket file's `.blob()` drops into `Bun.write()`:

```js
// Local file → bucket
await bucket.file("photo.jpg").write(Bun.file("./local/photo.jpg"));

// Bucket → local file
await Bun.write("./local/photo.jpg", await bucket.file("photo.jpg").blob());
```

### Resize an image with `Bun.Image`

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
- It is Bun only. On Node or other runtimes use `sharp`, which streams and pipes through `.nodeReadable()` / `.nodeWritable()` directly (see [Resize and upload images](#resize-and-upload-images) below).

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

### Which runtimes are supported?

Node, Bun, Deno, browsers, and Cloudflare Workers. Request signing uses **WebCrypto** (`crypto.subtle`), and reads/writes use the Web `fetch`, `Blob`, and Streams APIs, so there is no `node:crypto` dependency. The only Node-specific imports are `node:stream` (used solely by the optional `.nodeReadable()` / `.nodeWritable()` helpers) and `node:fs` / `node:os` (the FileSystem provider only).

On Cloudflare Workers, use a remote provider with the web helpers (`.stream()`, `.writable()`); enable the `nodejs_compat` flag if you also want the `.nodeReadable()` / `.nodeWritable()` helpers.

### What happens when a file doesn't exist?

`.info()` and `.exists()` never throw: they return `exists: false` and `false` respectively. All other read methods (`.text()`, `.json()`, `.arrayBuffer()`, etc.) will throw if the file doesn't exist.

### What happens on a network or auth error?

Methods throw a `Error` with a message containing the HTTP status code, e.g. `"S3 GET error: 403"`. There is no automatic retry. Wrap calls in try/catch if you need to handle errors gracefully:

```js
try {
  const text = await bucket.file("data.txt").text();
} catch (err) {
  console.error("Failed to read file:", err.message);
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
bun test           # everything below except the cloud emulators
```

The test suite has three layers, the first two of which need **no credentials**:

1. **Mocked unit tests** (`*/index.test.ts`): exercise each provider's request/response handling with a stubbed `fetch`.
2. **Signer oracle tests** (`lib/*.test.ts`): prove the request signing is correct without hitting any service:
   - S3/R2 AWS Signature V4 is cross-checked against [`aws4`](https://www.npmjs.com/package/aws4) (the reference signer): identical signature, byte for byte.
   - GCS V4 signatures are verified cryptographically against the public key.
3. **Integration tests** (`test/index.test.ts`): the full API against a real backend. FileSystem always runs; cloud providers run only when their credentials (or an emulator endpoint) are present.

### Without cloud credentials (emulators)

S3, R2, GCS and Azure can be tested end-to-end against local emulators. MinIO and Azurite **validate request signatures**, so a green run proves the signer against a real server.

```bash
npm run emulators:up      # MinIO (S3+R2), Azurite (Azure), fake-gcs-server (GCS), needs Docker
npm run test:emulators    # creates the buckets/container, then runs the suite
npm run emulators:down
```

Configuration lives in [`.env.emulators`](.env.emulators) (well-known emulator defaults, no secrets). Azurite is also available as a pure-npm devDependency, so the Azure suite can run without Docker:

```bash
npx azurite-blob --silent --location /tmp/azurite &
bun run emulators:setup
BUCKET=Azure bun --env-file=.env.emulators test test/index.test.ts
```

### With real cloud credentials

Copy `.env.sample` to `.env` and fill in the providers you want to exercise; the matching buckets are picked up automatically.
