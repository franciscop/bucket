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

## Getting Started

First install the library:

```sh
npm install bucket
```

Then decide which bucket you're going to use, and grab its credentials. Put them in a gitignored `.env`, let's say S3, so put these variables:

```sh
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_BUCKET=
# Optional
AWS_REGION=
AWS_SESSION_TOKEN=
AWS_ENDPOINT_URL=
AWS_PUBLIC_URL=
```

Finally, you can import and initialize the library:

```ts
import S3 from "bucket/s3";

// Read the variables automatically
const bucket = S3("bucket-name");

// Or inject them manually
const bucket = S3("bucket-name", {
  id: "...",
  secret: "...",
  region: "us-east-1",
  url: "...",
});
```

To use it, see the next section [Bucket API](#bucket-api), but here's a quick example reading and writing a JSON file:

```ts
const data = await bucket.file("test.json").json();
// data is a JS object here, since we're parsing it as .json()
await bucket.file("output.json").write(JSON.stringify(data));
```

## Bucket API

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

The root import exposes every service under its name, which is handy when a project talks to more than one. The subpath imports (`bucket/s3`, `bucket/fs`, ...) stay the slim, tree-shakeable option since the root bundles all providers:

```js
import bucket from "bucket";

const aws = bucket.S3("my-bucket", { id, secret });
const local = bucket.FS("./uploads");
const fake = bucket.Memory(); // for tests
```

Every bucket instance has the same methods:

- [`.info()`](#info): display the information about the current bucket.
- [`.list(filter?)`](#list): return the list of all files in the bucket.
- [`.scan(filter?)`](#scan): async generator that lazily yields files (streams pages).
- [`.count(filter?)`](#count): return the Number of items in the bucket.
- [`.remove(filter)`](#remove): delete all files matching the filter, returning them.
- [`.folder(path)`](#folder): a Bucket scoped to a path prefix (see below).
- [`.file(path)`](#file): creates a BucketFile instance for the given path.
- [`.create(body, options?)`](#create): writes the body under a random file name.

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
await bucket.remove(/\.tmp$/);
await bucket.remove(/./); // empties the bucket
```

The filter is required and must be a `RegExp`. Anything else, including no
argument at all and a plain string, throws a `BucketError` with code
`"INVALID_FILTER"` before a single request is made. This is deliberate: an
`undefined` variable can never silently become "delete everything", and strings
stay free to mean something narrower later.

Scope it to a folder instead of writing the prefix into the pattern:

```js
const deleted = await bucket.folder("cache").remove(/./); // everything under cache/
console.log(`removed ${deleted.length} files`);
```

On S3 and R2 the deletion is batched into as few requests as possible.

Removing is about the path, not the bytes. Afterwards the path stops resolving
everywhere: `.exists()` is `false`, reads throw `NOT_FOUND`, `.info()` is
`null`, and it is gone from `.list()`, `.scan()` and `.count()`. Removing the
same path twice is a no-op, not an error.

On a versioned bucket the earlier versions are kept, so removal is reversible
and keeps costing storage until a lifecycle rule expires them. Backblaze B2 is
always versioned: `.remove()` hides the file rather than deleting a version,
which stops the path resolving without uncovering the version before it.

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

Creates a [`BucketFile`](#file-api) handle for the given path, synchronously and without any network requests:

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
- [`.create(body, options?)`](#create): let the library pick the name.

### .create()

Writes the body under a random file name, resolving to the new file:

```js
await bucket.create(body);
await bucket.create(body, { type: "image/png" });
```

The name is a 21-character alphanumeric id, unique enough that you never need to check for collisions. Everything else works like [`file.write()`](#filewritebody-options), including the options. Combined with [`.folder()`](#folder) it is the usual way to accept an upload without trusting a client-supplied name:

```js
const file = await bucket.folder("avatars").create(upload);
file.path; // "avatars/V1StGXR8Z5jdHi6BmyT2a.png"
await db.user.update({ avatar: file.path });
```

The extension comes from `type` when you pass one, and otherwise from a name the body carries of its own, which means a `File` or a file from any bucket. A body with neither (a string, a `Buffer`, a bare `Blob`, a stream) gets an id with no extension, since guessing one from the bytes would be wrong as often as right.

```js
// A multipart parser gives you the type but no name worth trusting
await bucket.create(part.body, { type: part.mimetype }); // fO0k2lRz8qWpAx3cVbNmY.png
```

#### Related methods

- [`.file(path)`](#file): choose the name yourself.

## File API

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

- **Write** (each resolves to a file: the one written, copied, moved, renamed, or deleted)
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

|            | `publicUrl()` | `signedUrl()` | `uploadUrl()` |
| ---------- | :-----------: | :-----------: | :-----------: |
| **S3**     |      ✅       |      ✅       |      ✅       |
| **R2**     |      ✅       |      ✅       |      ✅       |
| **GCS**    |      ✅       |      ✅       |      ✅       |
| **Azure**  |      ✅       |      ✅       |      ✅       |
| **B2**     |      ✅       |      ✅       |      ❌       |
| **FS**     |      ❌       |      ❌       |      ❌       |
| **Memory** |      ❌       |      ❌       |      ❌       |

- ✅: returns a URL. For `publicUrl()` it only answers if the bucket or object is publicly readable, unless you set the [`publicUrl` config option](#filepublicurl), which every provider accepts; R2 and the filesystem return `null` without it. Signing needs a key: GCS returns `null` without a [service-account private key](#google-cloud-storage), Azure without an account key (managed identity).
- ❌: always returns `null`: B2 uploads require auth headers so a standalone upload URL cannot exist (use `.write()` instead), and neither the local filesystem nor the in-memory bucket has URLs of any kind.

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

Intermediate directories are created automatically. **Content-type** is inferred from the file extension (e.g. `.jpg` → `image/jpeg`, `.json` → `application/json`). You can override it and set other metadata through the optional second argument, where `type` takes either a MIME type or an extension (`"image/png"`, `"png"` and `".png"` are equivalent):

| Option         | Type                     | Description                                                                |
| -------------- | ------------------------ | -------------------------------------------------------------------------- |
| `type`         | `string`                 | MIME type or extension (overrides auto-detection)                          |
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

Size is not something you have to think about: anything past ~8 MiB is chunked internally, in bounded memory. See [Large file uploads](#large-file-uploads).

It resolves to the file itself, so a write can be the start of a chain:

```js
const file = await bucket.file("notes.txt").write("hello");
console.log(await file.text()); // "hello"
```

#### Related methods

- [`bucket.create(body, options?)`](#create): write under a generated name.

### file.copyTo(path)

Creates a duplicate of the file at a new path, keeping the original, and resolves to the copy:

```js
await file.copyTo("backup/photo.jpg");
await file.copyTo("../published/"); // trailing "/" keeps the file name
await file.copyTo(otherBucket.file("photo.jpg")); // into another bucket
```

The string destination resolves against the bucket or folder the file came from: `"../"` navigates toward the bucket root, a leading `/` means the bucket root, and a trailing `/` copies into that folder keeping the file name. Destinations outside the bucket throw a `BucketError` with code `"INVALID_PATH"`. Pass a `BucketFile` instead of a string to copy into another bucket, even one from a different provider.

```js
const doc = bucket.folder("drafts").file("doc.md");
const copy = await doc.copyTo("copy.md"); // drafts/copy.md
const published = await doc.copyTo("../published/"); // published/doc.md
published.path; // "published/doc.md"
```

#### Related methods

- [`.moveTo(path)`](#filemovetopath): same, removing the original.
- [`.rename(name)`](#filerenamename): change only the name.

### file.moveTo(path)

Moves the file to a new path, removing the original, and resolves to the moved file:

```js
await file.moveTo("photos/avatar.jpg");
await file.moveTo(otherBucket.file("avatar.jpg")); // into another bucket
```

The destination follows the same rules as [`copyTo()`](#filecopytopath).

```js
const avatar = await bucket.file("tmp/upload.jpg").moveTo("photos/avatar.jpg");
avatar.path; // "photos/avatar.jpg"
```

A move is a copy followed by a [`remove()`](#fileremove) of the source, so on a versioned bucket it leaves the source path's history behind exactly as a plain remove would. The bytes live at the new path and the old path stops resolving, but its earlier versions stay until a lifecycle rule expires them. On the filesystem it is a single atomic rename instead, with nothing left behind.

#### Related methods

- [`.copyTo(path)`](#filecopytopath): same, keeping the original.

### file.rename(name)

Renames the file within the same directory, resolving to the renamed file:

```js
const renamed = await bucket.file("photos/old-name.jpg").rename("new-name.jpg");
renamed.path; // "photos/new-name.jpg"
```

Throws if `name` is empty, `"."`, `".."`, or contains a `/`; use `.moveTo()` to change directories.

#### Related methods

- [`.moveTo(path)`](#filemovetopath): move anywhere in the bucket.

### file.remove()

Deletes the file, resolving to it:

```js
const gone = await bucket.file("temp.txt").remove();
gone.path; // "temp.txt", useful for logging what was deleted
```

It takes no arguments. Afterwards the path stops resolving: `.exists()` is
`false`, reads throw `NOT_FOUND`, and `.info()` is `null`. Removing a file that
is already gone is a no-op, not an error.

On a versioned bucket the earlier versions are kept, so removal is reversible
and keeps costing storage until a lifecycle rule expires them. Backblaze B2 is
always versioned: `.remove()` hides the file rather than deleting a version,
which stops the path resolving without uncovering the version before it.

Alias: `.unlink()`, matching Bun's `S3File`.

#### Related methods

- [`bucket.remove(filter)`](#remove): delete many files at once.

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

Use it as the target of `.pipeTo()` from any web `ReadableStream`. The stream uploads in ~8 MiB chunks with backpressure, so arbitrarily large files upload with constant memory.

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

Every provider takes a `publicUrl` config option: the origin the bucket is served from. Set it and `publicUrl()` returns `${publicUrl}/${file.path}`, which is how you put a CDN in front of a bucket (CloudFront over S3, Front Door over Azure, nginx over a local directory) and how dev and production return working URLs from the same code:

```js
const bucket = dev
  ? FileSystem("./public", { publicUrl: "http://localhost:3000/static" })
  : S3("my-bucket", { publicUrl: "https://cdn.example.com" });

await bucket.file("logo.png").publicUrl();
// dev:  "http://localhost:3000/static/logo.png"
// prod: "https://cdn.example.com/logo.png"
```

It is a declaration of where the bucket is served, not a promise that the URL resolves: the library does not serve the files, and a CDN pointed at the wrong bucket produces a wrong URL just as a local directory nobody is serving does.

Without it you get the provider's canonical address, which only answers if the bucket or object is publicly readable, and `null` where there is no such address: the local filesystem, and R2 (whose storage endpoint rejects unsigned requests). See the availability table at the top of this chapter for a per-provider summary.

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

The URL is cryptographically signed with your credentials and grants anyone holding it read access until it expires, so a private object can be shared without opening the bucket. Returns `null` when the credentials cannot sign: on GCS without a [service-account private key](#google-cloud-storage), on Azure when authenticating with managed identity instead of an account key, and always on the local filesystem.

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

It takes one option, `publicUrl` (or `FS_PUBLIC_URL`): the origin whatever serves the directory is reachable at, so `file.publicUrl()` returns a working URL in development instead of `null`.

```js
FileSystem("./public", { publicUrl: "http://localhost:3000/static" });
```

Paths are bucket-relative, exactly like the remote providers: a leading `/` means the bucket root (the folder above), never the filesystem root, and `file.path` is the path within the bucket. The real location on disk is `join(root, file.path)`. Nothing ever resolves outside the root folder; escapes throw a `BucketError` with code `"INVALID_PATH"`. The check is lexical: a symlink inside the folder that points outside is not caught.

As a safety net, passing the bucket's own OS path back in throws instead of silently nesting: `FileSystem("/data").file("/data/a.png")` is almost always a mistake for `file("a.png")`, so it throws `INVALID_PATH` with the suggested fix rather than creating `/data/data/a.png`.

Streaming writes go to a temporary `.tmp-` sibling and are renamed into place on completion, so a file is never observable half-written; `list()` skips these temp entries.

### Memory

An in-memory bucket backed by a `Map`, for tests: fast, no disk, nothing to clean up, and isolated per instance.

```js
import Memory from "bucket/memory";

const bucket = Memory();
await bucket.file("hello.txt").write("hello");
```

It is for tests only. It is not a cache, not a scratch bucket, and not for production: the data lives in one process's heap, dies with it, and is never shared. Two `Memory()` calls are two separate buckets, which is what lets tests run in parallel without colliding.

It is also the one provider that ignores nothing a write is given. `type`, `metadata`, `cacheControl` and `disposition` all round-trip through `info()`, where the filesystem quietly drops them, so it is the provider to develop against if you use metadata:

```js
const file = await bucket.file("report.txt").write("a,b", {
  type: "text/csv",
  metadata: { owner: "ana" },
});

(await file.info()).type; // "text/csv", not "text/plain"
```

Everything else matches the remote providers exactly: folders and path resolution, the error codes, `AbortSignal` support, both stream flavours, and `publicUrl` (which returns `null` unless you set the option, since nothing serves these bytes). `signedUrl()` and `uploadUrl()` are always `null`: there is no endpoint to sign for. Nothing is versioned, so `remove()` deletes.

| Option      | Env var             |
| ----------- | ------------------- |
| `publicUrl` | `MEMORY_PUBLIC_URL` |

### Backblaze B2

```js
import BackBlaze from "bucket/b2";

const bucket = BackBlaze("my-bucket-name", {
  id: "...", // Application Key ID
  secret: "...", // Application Key
});
```

Both a master key and a key restricted to one bucket work. A restricted key already identifies its bucket, so the name can be omitted; a key that is not restricted needs the `listBuckets` capability, since the bucket is resolved by name when authenticating.

Environment variable fallbacks:

| Option      | Env var                 |
| ----------- | ----------------------- |
| bucket name | `B2_BUCKET`             |
| `id`        | `B2_APPLICATION_KEY_ID` |
| `secret`    | `B2_APPLICATION_KEY`    |
| `publicUrl` | `B2_PUBLIC_URL`         |

### AWS S3

```js
import S3 from "bucket/s3";

const bucket = S3("my-bucket-name", {
  id: "...", // Access Key ID
  secret: "...", // Secret Access Key
  region: "us-east-1", // defaults to us-east-1
  url: "...", // optional: endpoint, without the bucket
});
```

Environment variable fallbacks:

| Option         | Env var                 |
| -------------- | ----------------------- |
| bucket name    | `AWS_BUCKET`            |
| `id`           | `AWS_ACCESS_KEY_ID`     |
| `secret`       | `AWS_SECRET_ACCESS_KEY` |
| `region`       | `AWS_REGION`            |
| `sessionToken` | `AWS_SESSION_TOKEN`     |
| `url`          | `AWS_ENDPOINT_URL`      |
| `publicUrl`    | `AWS_PUBLIC_URL`        |

`sessionToken` is the third part of a temporary STS credential; on Lambda, ECS and EC2 the whole trio is picked up from the environment automatically.

The `url` option is the endpoint **without** the bucket, which lets you point at any S3-compatible service:

```js
S3("my-bucket", { url: "http://127.0.0.1:9000" });
// requests go to http://127.0.0.1:9000/my-bucket/<key>
```

With no `url`, requests use AWS's virtual-hosted endpoint, `https://my-bucket.s3.<region>.amazonaws.com`. With one, the bucket is appended as a path segment, which is what MinIO, DigitalOcean Spaces and Ceph expect. Leave it unset for real AWS: S3 has deprecated path-style addressing.

### Cloudflare R2

```js
import R2 from "bucket/r2";

const bucket = R2("my-bucket", {
  id: "...", // Access Key ID
  secret: "...", // Secret Access Key
  account: "...", // Cloudflare account id
});
```

The endpoint is derived from `account`: `https://<account>.r2.cloudflarestorage.com/my-bucket`. Pass `url` instead for a custom endpoint or an emulator, without the bucket name, which gets appended. Giving both is fine if they agree; if they disagree, or if neither is set, the constructor throws a `BucketError` with code `"INVALID_CONFIG"`.

R2's storage endpoint is never publicly readable, so `file.publicUrl()` returns `null` unless you set `publicUrl` to the bucket's public domain (the `r2.dev` subdomain or a custom domain configured in Cloudflare):

```js
const bucket = R2("my-bucket", { publicUrl: "https://cdn.example.com" });
await bucket.file("logo.png").publicUrl();
// "https://cdn.example.com/logo.png"
```

Environment variable fallbacks:

| Option         | Env var                |
| -------------- | ---------------------- |
| bucket name    | `R2_BUCKET`            |
| `account`      | `R2_ACCOUNT_ID`        |
| `id`           | `R2_ACCESS_KEY_ID`     |
| `secret`       | `R2_SECRET_ACCESS_KEY` |
| `region`       | `R2_REGION`            |
| `sessionToken` | `R2_SESSION_TOKEN`     |
| `url`          | `R2_URL`               |
| `publicUrl`    | `R2_PUBLIC_URL`        |

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
| `publicUrl`   | `GCS_PUBLIC_URL`                 |

Signing uses the private key directly, so `signedUrl()` and `uploadUrl()` return `null` under the metadata server. The user credentials written by `gcloud auth application-default login` carry no private key either and cannot sign at all, so point `GOOGLE_APPLICATION_CREDENTIALS` at a service-account JSON file when you need signed URLs.

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
| `publicUrl`        | `AZURE_PUBLIC_URL`        |

The `url` option points at the Azurite emulator or a custom/sovereign cloud, e.g. `http://127.0.0.1:10000/devstoreaccount1`.

### More?

Open an [issue or PR](https://github.com/franciscop/bucket) if you'd like to see another service supported.

## Guides

A `BucketFile` is a **lazy remote handle, not a `Blob`**. It exposes the same read methods as a `Blob`, but to hand it to a Web API materialize it first:

- **`file.stream()`**: a web `ReadableStream`, for streaming bodies (no buffering).
- **`await file.blob()`**: a real `Blob`, for APIs that need one (`FormData`).

> Passing the `BucketFile` object _itself_ to `new Response(file)` or `FormData.append(name, file)` will **not** work: it is not a `Blob`, and would serialize as empty. Always use `.stream()` or `.blob()`.

### Serve over HTTP

`file.stream()` is a web `ReadableStream`, which is exactly what `Response` accepts, so bytes reach the client without the server ever holding the file:

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

Hardcoding the type only works when you already know it. [`info()`](#fileinfo) returns the real one along with the size, and doubles as the existence check:

```js
async fetch(req) {
  const file = bucket.file(new URL(req.url).pathname.slice(1));
  const info = await file.info();
  if (!info) return new Response("Not found", { status: 404 });

  return new Response(file.stream(), {
    headers: {
      "content-type": info.type ?? "application/octet-stream",
      "content-length": String(info.size),
      "last-modified": info.modified.toUTCString(),
    },
  });
}
```

That costs one extra round trip to the provider, so skip it when the type is known and a missing file can simply throw. To answer `Range` requests (video scrubbing, resumable downloads) serve [`file.slice()`](#fileslice) with a `206` instead.

Proxying spends your server's bandwidth on every byte. When the client can talk to the provider directly, redirect to a [`signedUrl()`](#filesignedurlopts) and let it do the transfer:

```js
const url = await file.signedUrl({ expires: "15min" });
return Response.redirect(url, 302);
```

### Attach to `FormData`

`FormData` needs a real `Blob`, so materialize the file with `await file.blob()`. Pass `file.name` as the third argument: without it the part carries no usable filename (`blob` on Node, empty on Bun) and servers commonly reject it or store it under the wrong name.

```js
const form = new FormData();
const file = bucket.file("avatar.png");
form.append("avatar", await file.blob(), file.name);

await fetch("https://api.example.com/upload", { method: "POST", body: form });
```

The blob carries the file's content type, so the part arrives as `image/png` rather than as opaque bytes.

This holds the whole file in memory, which is inherent to `FormData`: it needs the total length before it can build the multipart body. For large files send the body as a stream instead, as below.

### Streaming with fetch()

Passing `file.stream()` as a request body hands a file to another service without buffering it anywhere in between, so size stops mattering:

```js
await fetch("https://api.example.com/ingest", {
  method: "PUT",
  body: bucket.file("big.csv").stream(),
  duplex: "half", // required when the body is a stream
});
```

`duplex: "half"` is mandatory whenever the body is a stream: `fetch` throws before sending anything without it.

Since the length is not known up front the request is sent chunked, with no `Content-Length`. Most APIs accept that, but some require a length and will reject it; send `await file.blob()` in that case and accept the buffering. Streaming request bodies work on Node, Bun and Deno; in browsers they are Chromium-only and need HTTP/2.

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

### Accept an upload

An upload's file name is chosen by whoever is uploading, so it should never become a path. [`create()`](#create) writes the body under a generated name and hands back the file to store a reference to. What you pass it depends on what the framework parsed for you:

- a `File` or `Blob`: pass it straight through, the extension comes along with it.
- a stream: pass it with `{ type }`, since a stream carries no name.

Frameworks built on web standards (Hono, Next.js, Elysia, Bun, Deno, SvelteKit) give you a `File` from `FormData`:

```js
// Bun.serve, Hono, Next.js route handlers, Elysia, ...
async fetch(req) {
  const form = await req.formData();
  const file = await bucket.folder("avatars").create(form.get("avatar"));
  return Response.json({ path: file.path }); // "avatars/V1StGXR8Z5jdHi6BmyT2a.png"
}
```

### Fastify uploads

`@fastify/multipart` is stream-based, so `part.file` is a Node stream and the type comes from `part.mimetype`. Uploading from the stream means the file never has to fit in memory:

```js
import Fastify from "fastify";
import multipart from "@fastify/multipart";

const app = Fastify();
const uploads = bucket.folder("uploads");

app.register(multipart, {
  attachFieldsToBody: "keyValues",
  async onFile(part) {
    part.value = await uploads.create(part.file, { type: part.mimetype });
  },
});

app.post("/upload", async (req) => {
  return { path: req.body.profile.path }; // req.body.profile is a BucketFile
});
```

`part.mimetype` comes from the client's own headers, so validate it against an allowlist if you will serve the file back.

### Express and Multer

Multer takes a storage engine, which is where the upload goes. This one streams to the bucket and puts the `BucketFile` on `req.file`, plus the `path` and `size` that Multer users expect:

```js
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

function bucketStorage(bucket) {
  return {
    _handleFile(req, file, callback) {
      let size = 0;
      const meter = new Transform({
        transform(chunk, encoding, done) {
          size += chunk.length;
          done(null, chunk);
        },
      });
      Promise.all([
        pipeline(file.stream, meter),
        bucket.create(meter, { type: file.mimetype }),
      ])
        .then(([, bucketFile]) => {
          callback(null, { bucketFile, path: bucketFile.path, size });
        })
        .catch((error) => {
          meter.destroy(error);
          callback(error);
        });
    },
    // Called when Multer rolls an upload back
    _removeFile(req, file, callback) {
      if (!file.bucketFile) return callback(null);
      file.bucketFile.remove().then(() => callback(null), callback);
    },
  };
}

const upload = multer({ storage: bucketStorage(bucket.folder("uploads")) });

app.post("/upload", upload.single("profile"), (req, res) => {
  res.json({ path: req.file.path }); // req.file.bucketFile is the BucketFile
});
```

The same engine works with NestJS, whose `FileInterceptor` takes a Multer `storage`.

### Formidable uploads

Formidable's `fileWriteStreamHandler` has to return a `Writable` synchronously, so bridge it with a `PassThrough` and keep the upload's promise on the file that Formidable hands you:

```js
import formidable from "formidable";
import { PassThrough } from "node:stream";

const uploads = bucket.folder("uploads");

const form = formidable({
  fileWriteStreamHandler(file) {
    const stream = new PassThrough();
    file.bucketFile = uploads.create(stream, { type: file.mimetype });
    return stream;
  },
});

const [fields, files] = await form.parse(req);
const profile = await files.profile[0].bucketFile;
console.log(profile.path); // "uploads/81K2ladhL1tVdNrDvhPLR.png"
```

Putting the promise on `file` rather than on a variable outside the handler keeps each upload tied to its own field, so a form with several files works unchanged. Await every one of them: an upload nobody awaits turns a failure into an unhandled rejection.

### Large file uploads

There is nothing to do. Large files are chunked internally using whatever mechanism each provider expects, and streamed straight to disk on the filesystem, so uploading a small file and a huge one is the same call:

```js
await bucket.file("notes.txt").write("hello"); // a few bytes
await bucket.file("backup.tar").write(stream); // tens of gigabytes
```

Under ~8 MiB the body goes out as a single request, exactly as it always did. Past that, the upload switches to the provider's own chunked protocol:

| Provider   | Used internally                                       |
| ---------- | ----------------------------------------------------- |
| S3, R2     | Multipart upload (`UploadPart`, `CompleteMultipart…`) |
| Backblaze  | Large files (`b2_start_large_file`, `b2_upload_part`) |
| Azure      | Blocks (`Put Block`, `Put Block List`)                |
| GCS        | Resumable upload session                              |
| Filesystem | Streamed to disk, nothing to chunk                    |
| Memory     | Held as one buffer, nothing to chunk                  |

Memory stays at roughly one chunk no matter how big the file is, so this streams a file far larger than the machine's RAM:

```js
import { createReadStream } from "node:fs";

await bucket.file("backup.tar").write(createReadStream("./backup.tar"));
```

The same holds for [`writable()`](#filewritable) and [`nodeWritable()`](#filenodewritable), and for copying between providers, where the bytes are streamed rather than buffered:

```js
await r2.file("backup.tar").write(s3.file("backup.tar"));
```

A write that fails or is aborted partway cleans up the chunks it already uploaded, so a broken upload leaves nothing behind: no partial object, and no half-finished multipart session quietly accruing storage charges.

Providers cap how many chunks an upload may have, which sets the ceiling: 10,000 on S3, R2 and Backblaze puts it around 78 GB per file, and Azure's 50,000 blocks around 390 GB. A single request would have stopped at ~5 GB, and at whatever fits in memory.

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

**Direction:** `dst.write(src)` is a _pull_, so the file you call it on is the destination and it reads from the argument. `src.copyTo(dst)` and `src.moveTo(dst)` _push_ instead, and both accept either a path in the same bucket or a file from any other one.

### Bun's File

`Bun.file()` and `bucket.file()` are both lazy handles over the same `Blob` read API, one on disk and one in a bucket, so they compose in either direction:

```js
// Local file → bucket
await bucket.file("photo.jpg").write(Bun.file("./local/photo.jpg"));

// Bucket → local file
await Bun.write("./local/photo.jpg", await bucket.file("photo.jpg").blob());
```

Both of those hold the file in memory as it transfers, which is fine for photos and documents. Stream instead when the size is unbounded:

```js
// Local file → bucket
await Bun.file("./video.mp4")
  .stream()
  .pipeTo(bucket.file("video.mp4").writable());

// Bucket → local file, through a FileSink
const sink = Bun.file("./video.mp4").writer();
for await (const chunk of bucket.file("video.mp4").stream()) sink.write(chunk);
await sink.end();
```

`Bun.file()` does not touch the disk until it is read, so passing one that does not exist fails at `write()` time, not before. Use `await Bun.file(path).exists()` first if the path is not yours.

### Resize with sharp

[sharp](https://sharp.pixelplumbing.com) is a Node transform stream, so it slots between one file's reader and another's writer. Nothing buffers the whole image, which is what makes this safe for photos of any size:

```js
import { pipeline } from "node:stream/promises";
import sharp from "sharp";

await pipeline(
  bucket.file("original.jpg").nodeReadable(),
  sharp().resize(200, 200),
  bucket.file("thumbnail.jpg").nodeWritable(),
);
```

Changing format needs nothing extra: name the destination with the new extension and the stored content type follows from it.

```js
await pipeline(
  bucket.file("original.jpg").nodeReadable(),
  sharp().rotate().resize(400).webp(),
  bucket.file("thumbnail.webp").nodeWritable(), // stored as image/webp
);
```

`.rotate()` with no arguments applies the image's EXIF orientation, which photos from phones rely on: without it a portrait shot can arrive sideways.

Both ends are just files, so the source and the result can live in different providers:

```js
await pipeline(
  s3.file("uploads/a.jpg").nodeReadable(),
  sharp().resize(800),
  r2.file("thumbnails/a.jpg").nodeWritable(),
);
```

sharp runs anywhere Node does. On Bun, [`Bun.Image`](#resize-with-bunimage) does the same job with no dependency, working on bytes instead of streams.

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

Node.js, Bun, and Deno, fully. Cloudflare Workers works with the remote providers when the `nodejs_compat` flag is enabled (the flag is required to deploy at all, since every provider imports `node:stream` for the `.nodeReadable()` / `.nodeWritable()` helpers). `FileSystem` is not supported on Workers: there is no persistent disk, and recent Workers runtimes expose an in-memory `node:fs`, so writes may appear to succeed and then vanish.

Everything else is Web standards: request signing uses **WebCrypto** (`crypto.subtle`), and reads/writes use the Web `fetch`, `Blob`, and Streams APIs, so there is no `node:crypto` dependency. Beyond `node:stream`, the only Node-specific imports are `node:fs` / `node:os` in the FileSystem provider. For browsers, don't use this library directly (it would expose your credentials); hand the browser [`signedUrl()`](#filesignedurlopts) / [`uploadUrl()`](#fileuploadurlopts) links instead.

### What happens when a file doesn't exist?

`.info()` and `.exists()` never throw for a missing file: they return `null` and `false` respectively. All other read methods (`.text()`, `.json()`, `.arrayBuffer()`, etc.) will throw if the file doesn't exist.

### What happens on a network or auth error?

Methods throw a `BucketError` (a subclass of `Error`). Alongside the human-readable `message` it carries structured fields you can branch on:

- `code`: a normalized, uppercase string, one of `"NOT_FOUND" | "FORBIDDEN" | "UNAUTHORIZED" | "CONFLICT" | "INVALID_PATH" | "INVALID_FILTER" | "INVALID_CONFIG" | "ABORTED" | "UNKNOWN"`. It means the same thing across every provider, including the filesystem.
- `status`: the raw HTTP status, when the failure came from an HTTP response (absent for the filesystem).
- `provider`: which backend produced it (e.g. `"S3"`). Absent for `"INVALID_PATH"`, `"INVALID_FILTER"`, `"INVALID_CONFIG"` and `"ABORTED"`, which are thrown before any provider is involved. `"INVALID_CONFIG"` is thrown by the constructor, so an unusable bucket fails where you build it rather than on its first request.

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

### What happens on a versioned bucket?

Removing is about the path, never the history. After `.remove()` the path stops resolving (`.exists()` is `false`, reads throw `NOT_FOUND`, `.info()` is `null`, and it is absent from `.list()`, `.scan()` and `.count()`), but the versions written before it are kept:

| Service | What `.remove()` leaves behind               |
| ------- | -------------------------------------------- |
| S3, R2  | A delete marker; earlier versions stay       |
| GCS     | The generations become noncurrent            |
| Azure   | The blob and its snapshots go, versions stay |
| B2      | A hide marker; every version stays           |
| FS      | Nothing, the file is unlinked                |

So removal is reversible through the provider's own console or API, and the retained versions keep costing storage until a lifecycle rule expires them. Bucket never deletes a version, so it can never destroy data you cannot get back.

The same applies to [`.moveTo()`](#filemovetopath) and [`.rename()`](#filerenamename), which remove the source once the copy lands: a move within a versioned bucket duplicates the bytes rather than relocating them.

Backblaze B2 is always versioned, so it hides instead of deleting even when you never turned versioning on. Deleting its newest version would both destroy that version and uncover the one before it, resurrecting old content at a path you just removed.

### Can I cancel an operation?

Yes. Every method that does I/O takes an `AbortSignal`, and an aborted operation rejects rather than resolving:

```js
const controller = new AbortController();
setTimeout(() => controller.abort(), 100);

const text = await bucket.file("big.csv").text({ signal: controller.signal });
```

Readers take it as `{ signal }`, writes through the existing options object (`write(content, { signal })`), and the bucket methods after the filter (`list(filter, { signal })`, `remove(/./, { signal })`). `scan()` rejects when you call it rather than on the first iteration, and stops a loop already running.

An aborted operation never half-applies: nothing is written, nothing is deleted, and an in-flight multipart upload is cancelled rather than left open and billed.

The error suits both idioms. It is a `BucketError` with `code: "ABORTED"`, and its `name` mirrors the signal's own reason, so a timeout stays distinguishable from a cancel:

```js
try {
  await bucket.file("big.csv").text({ signal: AbortSignal.timeout(5000) });
} catch (err) {
  err.code; // "ABORTED", the same across every provider
  err.name; // "TimeoutError" here, "AbortError" for controller.abort()
  err.cause; // the signal's own reason
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
