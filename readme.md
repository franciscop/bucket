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

## Bucket Methods

Bucket() creates the instance attached to a single bucket; each service exports its own:

```js
S3("my-bucket-name", { id, secret, region });
S3(); // bucket name and credentials from env vars
```

The first argument is always the bucket name; the second is a config object with credentials. All fields fall back to environment variables, so in most setups you can omit them entirely. See [Services](#services) for the env var names and options of each provider.

```js
import S3 from "bucket/s3";

const bucket = S3("my-bucket-name", {
  id: "access-key-id",
  secret: "secret-access-key",
  region: "us-east-1",
});
await bucket.file("hello.txt").write("hello world");
```

Every bucket instance has the same methods:

- [`.info()`](#info): display the information about the current bucket.
- [`.list(filter?)`](#list): return the list of all files in the bucket.
- [`.scan(filter?)`](#scan): async generator that lazily yields files (streams pages).
- [`.count(filter?)`](#count): return the Number of items in the bucket.
- [`.remove(filter?)`](#remove): delete all files matching the filter, returning them.
- [`.folder(path)`](#folder): a Bucket scoped to a path prefix (see below).
- [`.file(path)`](#file): creates a BucketFile instance for the given path.

### .info()

Retrieves basic information about the bucket:

```js
await bucket.info();
```

Every provider resolves to the same `BucketInfo` shape: the provider `type`, the bucket `name`, its base `url`, and the account or credential `id`.

```js
const info = await bucket.info();
// {
//   id: "access-key-id",
//   name: "my-bucket-name",
//   type: "S3",
//   url: "https://my-bucket-name.s3.us-east-1.amazonaws.com"
// }
```

### .list()

Returns all the files in the bucket as an array of `BucketFile`:

```js
await bucket.list();
await bucket.list(/\.jpe?g$/);
```

Accepts an optional `RegExp` to filter by pattern; to scope to a path prefix, use [`.folder()`](#folder), whose filters match below the folder.

```js
const logs = await bucket.folder("logs").list(/\.log$/);
console.log(logs.map((file) => file.path)); // ["logs/access.log", ...]
```

You can also iterate the bucket directly with `for await`, which streams pages lazily and stops fetching if you `break`:

```js
for await (const file of bucket) {
  if (file.name.endsWith(".txt")) {
    console.log(await file.text());
  }
}
```

#### Related methods

- [`.scan(filter?)`](#scan): stream the listing page by page instead of buffering it.
- [`.count(filter?)`](#count): just the number of matches.

### .scan()

Lazily yields the files in the bucket, fetching provider pages as they are consumed:

```js
for await (const file of bucket.scan()) { ... }
for await (const file of bucket.scan(/\.log$/)) { ... }
```

Unlike the bare `for await (const f of bucket)` form it accepts an optional `RegExp` filter, so you can filter while streaming. That is ideal for very large buckets or when you may stop early; `list()` is simply `scan()` collected into an array, and the bare iteration delegates to it.

```js
for await (const file of bucket.scan(/\.log$/)) {
  if (await shouldStop(file)) break; // no further pages are fetched
}
```

#### Related methods

- [`.list(filter?)`](#list): the whole listing as an array.

### .count()

Counts the files in the bucket:

```js
await bucket.count();
await bucket.count(/\.jpe?g$/);
```

Accepts the same filter as `.list()`.

```js
const images = await bucket.count(/\.jpe?g$/);
console.log(`There are ${images} images`);
```

#### Related methods

- [`.list(filter?)`](#list): the matching files themselves.

### .remove()

Deletes every file matching the filter, returning the deleted files:

```js
await bucket.remove();
await bucket.remove(/\.tmp$/);
```

With no filter it empties the bucket (or the folder, when called on one). On S3 and R2 the deletion is batched into as few requests as possible.

```js
const deleted = await bucket.folder("cache").remove(); // everything under cache/
console.log(`removed ${deleted.length} files`);
```

#### Related methods

- [`file.remove()`](#fileremove): delete a single file.

### .folder()

Returns a `Bucket` scoped to a path prefix, synchronously and without any network requests:

```js
bucket.folder("public");
bucket.folder("../"); // navigate to the parent folder
```

It behaves like any other bucket, but every operation is confined to that folder: `.file()` resolves names inside it, and `.list()`, `.count()`, `.remove()`, and iteration only see files within it. Folders nest, and the prefix is normalized (`"./public/"` and `"public"` are equivalent). `folder("../")` navigates to the parent folder and `folder("/")` returns to the bucket root; navigation is bounded by the bucket root, so a path that would climb above it throws a `BucketError` with code `"INVALID_PATH"`.

```js
const assets = bucket.folder("public");
await assets.file("favicon.ico").write(icon); // stored at "public/favicon.ico"
const styles = await assets.folder("css").list(); // only files under "public/css/"
```

File paths are always the full path from the bucket root, on every provider including the filesystem, so `assets.file("favicon.ico").path` is `"public/favicon.ico"`. A `RegExp` passed to a folder's `.list()` is matched against the path below the folder, so `assets.list(/^favicon/)` matches `public/favicon.ico`.

#### Related methods

- [`.file(path)`](#file): a handle to a single file.
- [`.list(filter?)`](#list): list the folder's contents.

### .file()

Creates a [`BucketFile`](#file-methods) handle for the given path, synchronously and without any network requests:

```js
bucket.file("hello.txt");
bucket.file("photos/avatar.jpg");
```

The handle mirrors the `Blob` read API (`.text()`, `.json()`, `.arrayBuffer()`, `.bytes()`, `.blob()`, `.stream()`), but it is a **lazy remote handle, not a `Blob` itself**, so to hand it to `FormData`, `Response`, or `fetch`, materialize it first with `await file.blob()` (buffered) or `file.stream()` (streaming). See [Guides](#guides). It does not check whether the file exists, and it has two properties set immediately:

- `name`: the filename without the directory, e.g. `"avatar.jpg"`
- `path`: the full path within the bucket, e.g. `"photos/avatar.jpg"`

```js
const file = bucket.file("photos/avatar.jpg");
console.log(file.name); // "avatar.jpg"
console.log(await file.text()); // or .json(), or .stream(), etc
```

Paths are resolved within the bucket: `.` and `..` segments are applied and a leading `/` means the bucket root. The resolved path must stay inside the bucket; anything else throws a `BucketError` with code `"INVALID_PATH"`:

```js
bucket.file("photos/../a.txt"); // same file as bucket.file("a.txt")
bucket.file("/a.txt"); // leading "/" means the bucket root
bucket.file("../outside.txt"); // throws BucketError INVALID_PATH
```

#### Related methods

- [`.folder(path)`](#folder): scope a whole bucket to a prefix instead.

## File Methods

The file handle, returned by [`bucket.file()`](#file) and as every item of [`list()`](#list) and [`scan()`](#scan). The type is named `BucketFile` to differentiate it from the browser's native `File` object. It has `name` and `path` set synchronously, and everything else is a method:

- **Info**
  - `.name`: the filename without the directory.
  - `.path`: the full path within the bucket.
  - `.info()`: returns the file's metadata (`size`, `type`, `modified`, `version`, `metadata`), or `null` if the file does not exist.
  - `.exists()`: checks whether a file exists, returning `true` if it does.

- **Read**
  - `.text()`: read the contents of the file as a string.
  - `.json()`: read the contents of the file as parsed JSON.
  - `.arrayBuffer()`: read the contents of the file as an `ArrayBuffer`.
  - `.blob()`: read the contents of the file as a `Blob`.
  - `.bytes()`: read the contents of the file as a `Uint8Array`.
  - `.slice(start, end?)`: a read-only view of a byte range.
  - `.stream()`: returns a web `ReadableStream`.
  - `.nodeReadable()`: returns a Node.js `Readable` stream.

- **Write**
  - `.write(body, options?)`: writes content to the file.
  - `.copyTo(path)`: creates a duplicate of the file with a different name.
  - `.moveTo(path)`: moves the file to a different location.
  - `.rename(name)`: renames the file within the same folder.
  - `.remove()`: deletes the file (alias: `.unlink()`).
  - `.writable()`: returns a web `WritableStream`.
  - `.nodeWritable()`: returns a Node.js `Writable` stream.

- **URLs**
  - `.publicUrl()`: the permanent public URL of the file (or `null`).
  - `.signedUrl(opts)`: a time-limited download URL.
  - `.uploadUrl(opts)`: a time-limited upload URL.

URL availability per provider:

|           | `publicUrl()` | `signedUrl()` | `uploadUrl()` |
| --------- | :-----------: | :-----------: | :-----------: |
| **S3**    |      ✅       |      ✅       |      ✅       |
| **R2**    |      ❌       |      ✅       |      ✅       |
| **GCS**   |      ✅       |      ✅       |      ✅       |
| **Azure** |      ✅       |      ✅       |      ✅       |
| **B2**    |      ✅       |      ✅       |      ❌       |
| **FS**    |      ❌       |      ❌       |      ❌       |

- ✅: returns a URL. For `publicUrl()` it only answers if the bucket or object is publicly readable, and GCS/Azure signing needs key credentials (`null` with anonymous GCS or Azure managed identity).
- ❌: always returns `null`: R2's storage endpoint is never public (public access goes through an `r2.dev` or custom domain), B2 uploads require auth headers so a standalone upload URL cannot exist (use `.write()` instead), and the local filesystem has no URLs of any kind.

### file.info()

Retrieves the file's metadata, or `null` when the file does not exist:

```js
await bucket.file("photo.jpg").info();
// null, or:
// {
//   size: 175888,        // bytes; respects .slice() ranges
//   type: "image/jpeg",  // MIME type, null when unknown
//   modified: Date,      // when the content was last written
//   version: "...",      // provider version id, or null (see below)
//   metadata: {}         // custom metadata, lowercase keys
// }
```

Only a missing file resolves to `null`; other failures, like permissions or network errors, still throw. The `version` field is the provider's version identifier: the fileId on Backblaze, `generation` on GCS, `VersionId` on S3 and Azure when the bucket has versioning enabled, and `null` otherwise (always `null` for the local filesystem). The `metadata` field holds the custom key-value metadata set with `write(..., { metadata })`; keys are normalized to lowercase on both write and read so they round-trip consistently, and the local filesystem has no metadata store, so it always returns `{}`.

```js
const info = await bucket.file("photo.jpg").info();
if (!info) throw new Error("photo.jpg is missing");
console.log(`${info.size} bytes of ${info.type}, written ${info.modified}`);
```

#### Related methods

- [`.exists()`](#fileexists): just the boolean.

### file.exists()

Checks whether the file exists:

```js
await bucket.file("photo.jpg").exists(); // true or false
```

Shorthand for `(await file.info()) !== null`.

```js
const photo = bucket.file("photo.jpg");
if (await photo.exists()) { ... }
```

#### Related methods

- [`.info()`](#fileinfo): the full metadata.

### file.text()

Reads the full contents of the file, decoded as UTF-8:

```js
await bucket.file("readme.txt").text();
```

Matches the `Blob`/`Response` API. Throws `NOT_FOUND` if the file does not exist.

### file.json()

Reads the file contents parsed as JSON:

```js
await bucket.file("config.json").json();
```

Matches the `Blob`/`Response` API. Throws `NOT_FOUND` if the file does not exist.

### file.arrayBuffer()

Reads the raw binary contents as an `ArrayBuffer`:

```js
await bucket.file("photo.jpg").arrayBuffer();
```

Works in any runtime (see [Which runtimes are supported?](#which-runtimes-are-supported)). Matches the `Blob`/`Response` API.

```js
const buf = await bucket.file("photo.jpg").arrayBuffer();
const data = new Uint8Array(buf); // or Buffer.from(buf) in Node.js
```

### file.blob()

Reads the file contents as a `Blob`:

```js
await bucket.file("photo.jpg").blob();
```

Useful for passing to `FormData`, `Response`, or browser APIs; the Blob carries the file's content-type.

```js
const blob = await bucket.file("photo.jpg").blob();
const formData = new FormData();
formData.append("photo", blob, "photo.jpg");
```

### file.bytes()

Reads the raw binary contents as a `Uint8Array`:

```js
await bucket.file("photo.jpg").bytes();
```

Works in any runtime. Matches the `Blob`/`Response` API.

### file.slice()

Returns a **read-only view of a byte range** of the file, synchronously:

```js
bucket.file("big.csv").slice(0, 1024); // first 1 KiB
bucket.file("big.csv").slice(1024); // from 1 KiB to EOF
```

It works like [`Blob.slice()`](https://developer.mozilla.org/docs/Web/API/Blob/slice): `end` is exclusive and defaults to the end of the file. It returns a `BucketFile`, so every read method (`.text()`, `.bytes()`, `.arrayBuffer()`, `.blob()`, `.stream()`, `.nodeReadable()`) reads only that range. Remote providers translate it to an HTTP `Range` request; the filesystem reads only those bytes. Ranges are clamped to the file size and compose (`file.slice(0, 100).slice(10, 20)`).

```js
const head = await bucket.file("big.csv").slice(0, 1024).bytes();
```

`info().size` on a slice reports the **clamped slice length** (the bytes this view yields), while every other field (`type`, `modified`, `version`, `metadata`) still describes the underlying file:

```js
(await bucket.file("data.txt").slice(0, 4).info()).size; // 4
```

This makes range serving a one-liner, e.g. answering an HTTP `Range` request:

```js
const [start, end] = parseRange(req.headers.get("range")); // inclusive
const info = await file.info();
if (!info) return new Response("Not Found", { status: 404 });
const { size, type } = info;
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

Writes content to the file, replacing anything already there:

```js
await file.write("hello world"); // string
await file.write(new Uint8Array([1, 2, 3])); // Uint8Array or Buffer
await file.write(blob); // Blob
await file.write(stream); // web ReadableStream or Node.js Readable
await file.write(bucket.file("original.txt")); // another BucketFile (copies it)
```

Intermediate directories are created automatically. **Content-type** is inferred from the file extension (e.g. `.jpg` → `image/jpeg`, `.json` → `application/json`). You can override it and set other metadata through the optional second argument:

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
await file.copyTo("backup/photo.jpg");
await file.copyTo("../published/"); // trailing "/" keeps the file name
await file.copyTo(otherBucket.file("photo.jpg")); // into another bucket
```

The string destination resolves against the bucket or folder the file came from: `"../"` navigates toward the bucket root, a leading `/` means the bucket root, and a trailing `/` copies into that folder keeping the file name. Destinations outside the bucket throw a `BucketError` with code `"INVALID_PATH"`. Pass a `BucketFile` instead of a string to copy into another bucket, even one from a different provider.

```js
const doc = bucket.folder("drafts").file("doc.md");
await doc.copyTo("copy.md"); // drafts/copy.md
await doc.copyTo("../published/"); // published/doc.md
```

#### Related methods

- [`.moveTo(path)`](#filemovetopath): same, removing the original.
- [`.rename(name)`](#filerenamename): change only the name.

### file.moveTo(path)

Moves the file to a new path, removing the original:

```js
await file.moveTo("photos/avatar.jpg");
await file.moveTo(otherBucket.file("avatar.jpg")); // into another bucket
```

The destination follows the same rules as [`copyTo()`](#filecopytopath).

```js
await bucket.file("tmp/upload.jpg").moveTo("photos/avatar.jpg");
```

#### Related methods

- [`.copyTo(path)`](#filecopytopath): same, keeping the original.

### file.rename(name)

Renames the file within the same directory:

```js
await bucket.file("photos/old-name.jpg").rename("new-name.jpg");
// now at "photos/new-name.jpg"
```

Throws if `name` is empty, `"."`, `".."`, or contains a `/`; use `.moveTo()` to change directories.

#### Related methods

- [`.moveTo(path)`](#filemovetopath): move anywhere in the bucket.

### file.remove()

Deletes the file:

```js
await bucket.file("temp.txt").remove();
```

Alias: `.unlink()`, matching Bun's `S3File`.

#### Related methods

- [`bucket.remove(filter?)`](#remove): delete many files at once.

### file.stream()

Returns a web `ReadableStream<Uint8Array>` of the file contents, synchronously:

```js
bucket.file("video.mp4").stream();
```

Works in any runtime and matches `Blob.stream()`, so it plugs straight into `Response`, `pipeTo()`, and other web APIs.

```js
const stream = bucket.file("video.mp4").stream();
return new Response(stream); // stream it straight to an HTTP response
```

#### Related methods

- [`.nodeReadable()`](#filenodereadable): the Node.js flavor.

### file.nodeReadable()

Returns a Node.js `Readable` stream of the file contents:

```js
bucket.file("data.csv").nodeReadable();
```

Use it with Node.js `pipeline()` or any library that expects a Node stream.

```js
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

await pipeline(
  bucket.file("data.csv").nodeReadable(),
  createGzip(),
  bucket.file("data.csv.gz").nodeWritable(),
);
```

#### Related methods

- [`.stream()`](#filestream): the web flavor.

### file.writable()

Returns a web `WritableStream<Uint8Array>` that writes to the file, synchronously:

```js
bucket.file("output.txt").writable();
```

Use it as the target of `.pipeTo()` from any web `ReadableStream`.

```js
const stream = bucket.file("output.txt").writable();
await readableStream.pipeTo(stream);
```

#### Related methods

- [`.nodeWritable()`](#filenodewritable): the Node.js flavor.

### file.nodeWritable()

Returns a Node.js `Writable` stream that writes to the file:

```js
bucket.file("output.txt").nodeWritable();
```

Use it with Node.js `pipeline()` or any library that writes to a Node stream.

```js
import { pipeline } from "node:stream/promises";

await pipeline(
  bucket.file("input.txt").nodeReadable(),
  bucket.file("output.txt").nodeWritable(),
);
```

#### Related methods

- [`.writable()`](#filewritable): the web flavor.

### file.publicUrl()

Retrieves the file's permanent, unauthenticated URL, or `null`:

```js
await bucket.file("logo.png").publicUrl();
// "https://my-bucket.s3.us-east-1.amazonaws.com/logo.png" or null
```

The URL is the file's canonical address; whether it actually answers depends on the bucket or object being publicly readable. It is `null` when the provider has no public URL at all: always on the local filesystem, and on R2, whose storage endpoint rejects unsigned requests (public R2 access goes through an `r2.dev` or custom domain). See the availability table at the top of this chapter for a per-provider summary.

```js
// Serve a public URL when available, falling back to a temporary signed one:
const src =
  (await file.publicUrl()) ?? (await file.signedUrl({ expires: "1h" }));
```

#### Related methods

- [`.signedUrl(opts)`](#filesignedurlopts): a time-limited URL for private files.

### file.signedUrl(opts)

Creates a time-limited signed URL to download the file:

```js
await file.signedUrl({ expires: 3600 }); // seconds
await file.signedUrl({ expires: "15min" }); // or a duration string
```

The URL is cryptographically signed with your credentials and grants anyone holding it read access until it expires, so a private object can be shared without opening the bucket. Returns `null` when the credentials cannot sign (GCS without a service-account key, Azure with managed identity) and always on the local filesystem.

```js
const url = await bucket.file("invoice.pdf").signedUrl({ expires: "15min" });
await sendEmail({ to: user.email, link: url });
```

#### Related methods

- [`.uploadUrl(opts)`](#fileuploadurlopts): the same for uploads.
- [`.publicUrl()`](#filepublicurl): the permanent address of public files.

### file.uploadUrl(opts)

Creates a time-limited signed URL that accepts a `PUT` upload to this path:

```js
await file.uploadUrl({ expires: 300 }); // seconds
await file.uploadUrl({ expires: "5min" }); // or a duration string
```

It lets a browser upload directly to the bucket without ever seeing your credentials. Same `expires` and `null` rules as `signedUrl()`, plus `null` on Backblaze, whose API has no standalone upload URLs (use `.write()` instead).

```js
// Server: hand the browser a one-off upload address
const url = await bucket.file(`uploads/${crypto.randomUUID()}.jpg`).uploadUrl({
  expires: "5min",
});

// Browser: upload straight to the bucket
await fetch(url, { method: "PUT", body: fileInput.files[0] });
```

#### Related methods

- [`.signedUrl(opts)`](#filesignedurlopts): the same for downloads.
- [`.write(body)`](#filewritebody-options): upload through your server instead.

## Services

All services share the same API. The only difference is how you initialize the bucket. The small differences are noted in each section, please familiarize yourself with the ones you use:

### Filesystem FS

Treats a local folder as a bucket. Useful for development, testing, or when you just want a consistent file API over local disk.

```js
import FileSystem from "bucket/fs";

const bucket = FileSystem("./my-folder");
```

The path is resolved relative to the current working directory. No credentials needed.

Paths are bucket-relative, exactly like the remote providers: a leading `/` means the bucket root (the folder above), never the filesystem root, and `file.path` is the path within the bucket. The real location on disk is `join(root, file.path)`. Nothing ever resolves outside the root folder; escapes throw a `BucketError` with code `"INVALID_PATH"`. The check is lexical: a symlink inside the folder that points outside is not caught.

As a safety net, passing the bucket's own OS path back in throws instead of silently nesting: `FileSystem("/data").file("/data/a.png")` is almost always a mistake for `file("a.png")`, so it throws `INVALID_PATH` with the suggested fix rather than creating `/data/data/a.png`.

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
const info: FileInfo | null = await file.info();
```

### Which runtimes are supported?

Node, Bun, Deno, browsers, and Cloudflare Workers. Request signing uses **WebCrypto** (`crypto.subtle`), and reads/writes use the Web `fetch`, `Blob`, and Streams APIs, so there is no `node:crypto` dependency. The only Node-specific imports are `node:stream` (used solely by the optional `.nodeReadable()` / `.nodeWritable()` helpers) and `node:fs` / `node:os` (the FileSystem provider only).

On Cloudflare Workers, use a remote provider with the web helpers (`.stream()`, `.writable()`); enable the `nodejs_compat` flag if you also want the `.nodeReadable()` / `.nodeWritable()` helpers.

### What happens when a file doesn't exist?

`.info()` and `.exists()` never throw for a missing file: they return `null` and `false` respectively. All other read methods (`.text()`, `.json()`, `.arrayBuffer()`, etc.) will throw if the file doesn't exist.

### What happens on a network or auth error?

Methods throw a `BucketError` (a subclass of `Error`). Alongside the human-readable `message` it carries structured fields you can branch on:

- `code`: a normalized, uppercase string, one of `"NOT_FOUND" | "FORBIDDEN" | "UNAUTHORIZED" | "CONFLICT" | "INVALID_PATH" | "UNKNOWN"`. It means the same thing across every provider, including the filesystem.
- `status`: the raw HTTP status, when the failure came from an HTTP response (absent for the filesystem).
- `provider`: which backend produced it (e.g. `"S3"`). Absent for `"INVALID_PATH"`, which is thrown before any provider is involved.

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
