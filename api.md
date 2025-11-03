# API

Description of how the `bucket` API works. All of the different buckets behave the same as described in this API, except for some minor differences noted in their respective sections:

```js
// Importing 3 libraries
import FileSystem from "bucket/fs";
import Amazon from "bucket/s3";
import CloudFlare from "bucket/r2";

// Initializating them
const fsBucket = FileSystem("./test/bucket");
// the local filesystem initialization refers to a folder, while other buckets refer to the bucket name from that environment + credentials

const awsBucket = Amazon("mybucketname", {
  id: process.env.BUCKET_S3_ID,
  key: process.env.BUCKET_S3_KEY,
});

const r2Bucket = CloudFlare("mybucketname", {
  id: process.env.BUCKET_R2_ID,
  key: process.env.BUCKET_R2_KEY,
});

// All of tshose buckets are an instance of Bucket that behave similarly. We'll name it "bucket" as a generic name from this point on

// -- BUCKET --
const info = await bucket.info();    // Get all of the bucket info
const files = await bucket.list();   // The list of all the files in the bucket
const count = await bucket.count();  // The count of the number of files in the bucket
for await (const file of bucket) {   // Iterate through each of the files in series
  if (file.name.endsWith('.txt')) {
    console.log(await file.text());
  }
}

// -- FILE --
const file = bucket.file("myfile.txt");   // A reference to a single file in the bucket

// -- READ --
// Reading text data
const file = bucket.file("myfile.txt");
const info = await file.info();   // Get the file extended info; id, name, date, mime type, etc
const data = await file.text();   // Plain utf-8 reading text
const data = await file.json();   // Parses the text as json
const data = await file.buffer(); // Contents as ArrayBuffer
const data = await file.blob();   // Return a Blob representation
const data = await file.bytes();  // Contents as Uint8Array

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
const localFilePath = './test/bucket/test.txt';
const remoteFilePath = './newname.txt';
// Using the native methods:
await bucket.upload(localFilePath, remoteFilePath);
// local src (based on CWD) to remote dst (based on the bucket path)
await bucket.download(remoteFilePath, localFilePath);
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


## FAQ

### What are "web streams" vs "node streams"?

When Node.js was created, there was no native streaming in Javascript (nor `async/await` for that matter!). So Node.js created a system to do streaming of files that is now popularly known as "Node(.js) streams".

However few years later, the Javascript standards body created an actual streaming API. It was first implemented for the web and fetch(), and so it's now popularly known as "web streams".

Unfortunately, those are not directly compatible (though there are compatibility layers out there), so when you are trying to do file streaming, you are normally limited by whatever the platform supports. You usually do streaming _from a source_ _into a destination_, with optional transformation. If one of those are out of your control and already uses either web or node streams, the rest of your system should use the same as well.

Example: if you are trying to use [the popular library Sharp](https://sharp.pixelplumbing.com/) for image modification, they use Node.js streams and so you'll need your input data to be a Node.js stream as well:

```js
const readableStream = bucket.file('input.png').readable("node");
const transformer = sharp().resize(300);
const writableStream = fs.file("output.png").writable("node");

readableStream.pipe(transformer).pipe(writableStream);
````
