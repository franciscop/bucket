# API

A small definition for the API of bucket:

```js
// Importing 3 libraries
import FileSystem from "bucket/fs";
import Amazon from "bucket/s3";
import CloudFlare from "bucket/r2";

// Initializating them
const fs = FileSystem("test/bucket");

const aws = Amazon("mybucketname", {
  id: process.env.BUCKET_S3_ID,
  key: process.env.BUCKET_S3_KEY,
});

const r2 = CloudFlare("mybucketname", {
  id: process.env.BUCKET_R2_ID,
  key: process.env.BUCKET_R2_KEY,
});

// Assume the bucket is just called `bucket` by now

// -- BUCKET --
const info = await bucket.info();
const files = await bucket.list();
const count = await bucket.count();
for await (const file of bucket) {
  if (file.name.endsWith('.txt')) {
    console.log(await file.text());
  }
}

// -- FILE --
const file = bucket.file("myfile.txt");

// -- READ --
// Reading text data
const file = bucket.file("myfile.txt");
const info = await file.info();  // Get the file extended info; id, name, date, mime type, etc
const data = await file.text(); // Plain utf-8 reading text
const data = await file.json(); // Parses the text as json
const data = await file.buffer(); // Contents as ArrayBuffer
const data = await file.blob(); // Return a Blob representation
const data = await file.bytes(); // Contents as Uint8Array

// Streaming the byte data
const img = bucket.file("myfile.jpg");
await img.readable().pipeTo(webWritePipe);
await img.readable("web").pipeTo(webWritePipe);  // Same
img.readable("node").pipe(nodeWritePipe); // No await available ;_;
await pipeline(img.readable("node"), nodeWritePipe);

// -- WRITE --
// Write in many formats
const file = bucket.file("myfile.txt");
await file.write("the content");
await file.write(JSON.stringify({ hello: "world" }));
await file.write(webReadStream); // web write stream method 1
await file.write(nodeReadStream); // node write stream method 1

// Writing with a stream
const img = bucket.file("myfile.jpg");
await webReadStream.pipeTo(img.writable()); // web write stream method 2
await webReadStream.pipeTo(img.writable("web")); // web write stream method 2
await pipeline(nodeReadStream, img.writable("node"));

// -- UPLOAD/DOWNLOAD --
// Using the native methods:
await bucket.upload('./test/bucket/test.txt', './newname.txt');
// local src (based on CWD) to remote dst (based on the bucket path)
await bucket.download('./test.txt', './test/bucket/newname.txt');
// remote src (based on the bucket path) to local dst (based on CWD)

// Using the native `node:fs` API:
// Uploading
const source = fs.createReadStream('./test/bucket/test.txt');
const target = bucket.file('./newname.txt').writable('node');
await pipeline(source, target);

// Downloading
const source = bucket.file('./test.txt').readable('node');
const target = fs.createWriteStream('./test/bucket/newname.txt');
await pipeline(source, target);

// Using two buckets and WebStreams, one can be FS and the other e.g. S3, B2, etc:
// Uploading
const source = fs.file('test.txt').readable();
const target = s3.file('newname.txt').writable();
await source.pipeTo(target);

// Downloading
const source = s3.file('test.txt').readable();
const target = fs.file('newname.txt').writable();
await source.pipeTo(target);

// Write from s3 to a local file
fs.file("myfile.txt").write(s3.file("myfile.txt")); // most straightforward

s3.file("myfile.txt").readable().pipeTo(fs.file("myfile.txt").writable());
s3.file("myfile.txt").readable("node").pipe(fs.file("myfile.txt").writable("node"));
```
