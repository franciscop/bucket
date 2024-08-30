# Bucket

> Early WIP; right now only the Backblaze B2 `bucket/b2` and Local Filesystem `"bucket/fs"` are available.

A small library to talk to any of the popular file storage solutions with a unified API:

```js
// Simple example displaying all of the files in the bucket
import BackBlaze from "bucket/b2"; // or /s3, /r2, /fs, etc

const bucket = BackBlaze("bucket-name", { id, key });

const file = bucket.file('demo.txt');
await file.write('hello world');
console.log(await file.text());
```

It has different engines and they all behave the same. It also has a "filesystem" Bucket, which will treat a local folder as a bucket:

```js
// More complex example with streams and pipes
import FileSystem from "bucket/fs";
import BackBlaze from "bucket/b2";

const fs = FileSystem("./public/");
const b2 = BackBlaze("mybucketname", { id, key });

// Zip all of the local files and upload those zips to B2
const source = fs.file("local.txt").readable();
const target = b2.file("newfile.txt").writable();
await source.pipeTo(target);
```

## API

There are two main APIs, the `Bucket` one and the `File` one:

- `Bucket()` initialize the instance attached to a single bucket.
  - `.info()`: display the information about the current bucket.
  - `.list(filter?)`: return the list of all files in the bucket.
  - `.count(filter?)`: return the Number of items in the bucket.
  - `.upload(localSrc, remoteDst)`: copies a file from the local filesystem into the specified path of the bucket.
  - `.download(remoteSrc, localDst)`: copies a file from the bucket into the specified path of the local filesystem.
  - `.file(path)`: creates a File instance for the given path
- `File` instance (created with `.file()`, or each item in the `list()`). It has `id`, `name` and `path` already:
  - `.info()`: returns some more details of the file, like `date` (creation time), `type` (mime type) and `size`.
  - `.exists()`: checks whether a file exists, returning true if it does.
  - `.text()`: read the contents of the file as a string
  - `.json()`: read the contents of the file as a string and parse it as JSON
  - `.buffer()`: read the contents of the file as an ArrayBuffer
  - `.blob()`: read the contents of the file as a Blob
  - `.bytes()`: read the contents of the file as a Uint8Array
  - `.write(body)`: writes the content of the body into the file. You can pass a lot of things there.
  - `.copy(path)`: creates a duplicate of a file with a different name (keeping the original).
  - `.move(path)`: change the location of the file (removing the original).
  - `.rename(path)`: change the name of the file enforcing it remains in the same folder (removing the original).
  - `.remove()`: deletes the file completely.

### Bucket()

### bucket.info()

### bucket.list()

### bucket.count()

### bucket.upload()

Copy a file from the local filesystem into the specified path of the bucket.

### bucket.download()

### bucket.file()

### file.info()

### file.exists()

### file.text()

### file.json()

### file.buffer()

### file.blob()

### file.bytes()

### file.write(body)

### file.copy(path)

### file.move(path)

### file.rename(path)

### file.remove()

## Services

This documentation section is to explain how to initialize each services, and any potential difference from the API described above.

### Filesystem FS

### Backblaze B2

### AWS S3

### Cloudflare R2

### More ?

## Advanced

### Pipes introduction

This tutorial focuses on best practices around pipes and streaming. A pipe is an operation that moves data from a source to a destination, with optionally some transformation operations in the middle. It's useful to **keep the memory consumption low** when working with large files and **to perform transformation operations** to files.

The simplest example I can think is copying a file; read the original one and copying everything to the destination path:

```js
// The native operation
bucket.copy("/myfile.txt", "/copied.txt");

// Similar to the above but using pipes (for demonstration purposes). Note that
// we don't use any await/.then, and the .write() only has one argument
bucket.read("/myfile.txt").pipe(bucket.write("/copied.txt"));

// If we knew the files are small, we could do this instead:
const data = await bucket.read("/myfile.txt");
await bucket.write("/copied.txt");
```

Something you might've noticed is that we don't know when the pipe finishes executing, for that we can use the helper `pipeline()` that makes the piping operation into an async one:

```js
import { pipeline } from "node:stream/promises";

// Same as above with .pipe(), but this time we can await the whole thing:
await pipeline(bucket.read("/myfile.txt"), bucket.write("/copied.txt"));
```

Let's say we want to resize an image with `sharp`, then we can use pipes as well:

```js
import { pipeline } from "node:stream/promises";
import sharp from "sharp";

// Same as above with .pipe(), but this time we can await the whole thing:
const srcImg = bucket.read("/myimg.png");
const resize = sharp().resize(200, 200);
const dstImg = bucket.write("/preview/myimg.png");

// Perform the operation while creating a new file and not wasting memory
await pipeline(srcImg, resize, dstImg);
```

## Examples

### User profile pictures

> Multiple ways; signed URL, express bodyParser

### Zip and upload files

### Resize and upload images
