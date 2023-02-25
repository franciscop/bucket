# Bucket

> Early WIP; right now only the Backblaze B2 `bucket/b2` and Local Filesystem `"bucket/fs"` are available.

Access any of the popular storage solutions with a unified API:

```js
// Simple example displaying all of the files in the bucket
import Bucket from "bucket/b2"; // or /b2, /r2, /fs, etc

const bucket = Bucket("bucket-name", { id, key, ...options });
console.log(await bucket.list());
```

It has different engines and they all behave the same, so using or migrating from one to another becomes trivial. It also has a "filesystem" Bucket, which will treat a local folder as a bucket:

```js
// More complex example with streams and pipes
const { pipeline } = require("stream");
import FS from "bucket/fs";
import B2 from "bucket/b2";

const fs = FS("./localdata");
const b2 = B2("mybucketname", { id, key });

// Zip all of the local files and upload those zips to B2
await fs.list().map(async (file) => {
  await pipeline(fs.read(file), zlib.createGzip(), s2.write(file + ".tar.gz"));
});
```

## API

All of the methods are async:

- `Bucket()` initialize the instance attached to a single bucket.
- `.info()`: display the information about the current bucket.
- `.count()`: return the Number of items in the bucket.
- `.list()`: return the list of all files in the bucket.
- `.upload()`: copies a file from the local filesystem into the specified path of the bucket.
- `.download()`: copies a file from the bucket into the specified path of the local filesystem.
- `.read()`: returns the contents of the bucket file as a string.
- `.write()`: writes the contents of the bucket file from a plain string.
- `.remove()`: deletes a file from the bucket.
- `.exists()`: checks whether a file exists. Note that there are no real folders in most bucket implementations, it's all only files and the `/` is the separator, not actually folder paths.
- `.copy()`: creates a duplicate of a file with a different name.
- `.sign()`: sign a specific path for read or write, returns the full URL endpoint.

### Bucket()

### bucket.info()

### bucket.count()

### bucket.list()

### bucket.upload()

Copy a file from the local filesystem into the specified path of the bucket.

### bucket.download()

### bucket.read()

### bucket.write()

### bucket.remove()

### bucket.exists()

### bucket.copy()

### bucket.sign()

> Note: returns `null` in FS

## Services

This documentation section is to explain how to initialize each services, and any potential difference from the API described above.

### Backblaze B2

### Filesystem FS

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

### Cache

> Not yet available, [follow me](https://twitter.com/fpresencia) for updates.

By default there's no local cache since normal workflows mean that the cache might be more troublesome than helpful. However, under _the rules of Bucket cache_ you might want to enable the cache for great **performance gains** and **cost reduction**:

- You create a single instance for a given bucket and only use that within your code (this is recommended anyway).
- Your Node.js app is running in a single instance in a single server; that is no multi-process, not in multiple threads or servers, not in a distributed format, etc.
- No one (person, scripts, programs, etc) are editing the bucket files in parallel to your Node.js bucket.

What this ensures is that if we do a `.list()` once reading the real files, any change of those files will only happen through this library, and so we can maintain a consistent mapping of the bucket cache and the actual files.

To enable the cache you can specify a Number for a time in seconds, or a string with the time units (`s` = seconds, `m` = minutes, `h` = hours, `d` = days):

```js
const bucket = Bucket("my-bucket", { id, key, cache: "100s" });

// 300~500ms - first time, cold cache
await bucket.list();

// 0-1ms - subsequent times, hot cache
await bucket.list();
```

If you break _the rules of Bucket cache_ your bucket will be broken beyond repair, let's say you create two instances for the same bucket:

```js
// BROKEN; DO NOT DO THIS
const b1 = Bucket("my-bucket", { id, key, cache: "100s" });
const b2 = Bucket("my-bucket", { id, key, cache: "100s" });

await b1.upload("./local.txt", "/remote.txt");

await b1.exists("/remote.txt");
// TRUE, since the b1 cache has correctly mapped the operation

await b2.exists("/remote.txt");
// FALSE, while it should've said "true", since it has an outdated cache
```

## Examples

### User profile pictures

> Multiple ways; signed URL, express bodyParser

### Zip and upload files

### Resize and upload images
