# Bucket Specification

This document defines an API specification for those interested on adding a new vendor, so that we maintain compatible APIs for all of our users.

cloud-bucket.com

## Importing

You can import a specific vendor as shown:

```js
import Bucket from "bucket/s3";
```

If you want to import multiple vendors at the same time, you'll need to name them differently:

```js
import AmazonBucket from 'bucket/s3';
import BackblazeBucket from 'bucket/b2';
import CloudflareBucket from 'bucket/r2';
import FileBucket from 'bucket/fs';  // local folder acting as a "bucket"
...

import S3 from 'bucket/s3';
import B2 from 'bucket/b2';
import R2 from 'bucket/r2';
import FS from 'bucket/fs';  // local folder acting as a "bucket"
...
```

These are all the constructors/classes; you can also create multiple instances from the same vendor, but for that see the next section.

Notably, these should **not** be followed:

```js
// WRONG - they are not aggregated into a single file
import { S3 } from "bucket";

// WRONG - there's a single default export
import * as S3 from "bucket/s3";
```

## Constructor

The constructor will be in the form of:

```js
const bucket = Bucket("bucket-name", { id, key, ...options });
const bucket2 = Bucket("namespace:bucket-name", { id, key, ...options });
```

Specifically to note:

- In the docs, examples, etc. the class will be capitalized but the instance will not.
- Bucket() doesn't need the keyword `new`.
- Bucket() doesn't need the keyword `await`. If needed to be async, it'll be queued internally and finishes connecting on the first API call (since all API calls are async).
- The first argument is the name of the bucket.
- The name of the bucket can be namespaced by e.g. the ProjectID, the vendor, or some other way that vendors finds. This should be a string separated by a colon `:` as shown.
- The second argument is an object for the options, which might include the `id` and `key` for auth.
- The `id` and `key` are whatever is used to authenticate your product/user. The vendor might call it by vastly different names, but we standardize those to `id` and `key`. Examples: Backblaze B2 calls the bucket `id` as `keyID`, while they call the `key` as `applicationKey`. A list of examples should be provided below.
- That said, you _might_ need additional keys/options to fully connect, provide them as the rest of the options in clear short names that are well documented in the vendor documentation. This does _not_ include the projectId/namespace, which should be provided within the bucket name as specified.
- Users might create multiple instances from the same bucket, or from different buckets, or from different vendors. You should not assume a single instance for any reason (e.g. local memory cache for a single-instance Node.js app).
- The variables `id` and `key` are expected to be in the users' `.env` file, and maybe `bucket-name` as well.
- All methods are expected to be async.
- All methods are to be wrapped with the `swear` promise wrapper.
- Where it makes sense, methods must be pipeable, e.g. `s3.read('file.txt').pipe(writeFile)`.
-

## Methods

```js
// Return bucket/account related info, as a (nested?) object
bucket.info();

// Display all of the files, or that match the prefix filter
bucket.list();
bucket.list(prefix);

// Return the number of files in the bucket, or that match the prefix filter
bucket.count();
bucket.count(prefix);

// Upload a local file. Create a new name, optionally with a prefix
bucket.upload(local);
bucket.upload(local, remote);
bucket.upload(local, prefix);

bucket.download(remote);
bucket.download(remote, local);
bucket.download(prefix);
bucket.download(prefix, localPrefix);

bucket.read(remote);
bucket.write(remote, data);

bucket.exists(remote);

bucket.remove(prefix);
bucket.remove(remote);
bucket.remove([remote1, remote2]);
```

## Changing vendor

The variables `id`, `key` and potentially `bucket-name` are expected to be in the users' `.env` file, such as this:

```js
import Bucket from "bucket/s3";

const bucket = Bucket(process.env.BUCKET_NAME, {
  id: process.env.BUCKET_ID,
  key: process.env.BUCKET_KEY,
});
```

They will look something like this in the `.env`:

```bash
# .env (note: fake credentials, literally a keyboard smash)
BUCKET_NAME=myfiles
BUCKET_ID=asdfasfasdf
BUCKET_KEY=asdfasfasdf
```

As such, to change a vendor you'd need to change:

- The way of importing it, replace `"bucket/s3"` for e.g. `"bucket/r2"`.
- The credentials in your `.env` file to use the new vendor credentials.
- Restart the Node.js server to catch those changes.

### Ramblings

We don't have the concept of "local root folder" when uploading/downloading files (except that is, the filesystem absolute root, which is not what we want). So if we try to keep the name when uploading this happens:

```js
// NOT HOW IT WORKS, just an example of the issue:
bucket.upload("./demo/sub/local.txt" /* expecting to keep the path */);
// If we don't normalize it internally, it'll be uploaded to
// /users/francisco/projects/bucket/demo/sub/local.txt
```

This is because './demo/sub/local.txt' is the equivalent to the long path shown above, we cannot/should not rely on local path strings being relative to anything, so we can only upload to the root, or to the specified prefix:

```js
bucket.upload("./demo/sub/local.txt", "/sub/");
// Correctly uploads to `/sub/{name}.txt`

bucket.upload("./demo/sub/local.txt", "/sub/local.txt");
// Correctly uploads to `/sub/local.txt`
```

If wanted though, we have an abstraction for that! It's the local bucket, you can treat a folder in your project as a local bucket:

```js
const fs = Bucket("./demo");
await fs.list();
// ['/local.txt']
```

That way we can work with e.g. Backblaze and our local filesystem in a more intuitive way:

```js
import FileBucket from 'bucket/fs';
import BackblazeBucket from 'bucket/b2';

const fs = FileBucket('./demo');
const b2 = BackblazeBucket(...);

// This _will_ preserve the right filename and structure
fs.read('/local.txt').pipe(b2.upload);
```
