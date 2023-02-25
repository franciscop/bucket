# File Bucket

This is a special bucket that will treat a folder in your filesystem as a bucket. It is primarily intended for doing dev in this way, then when deploying to production using a real bucket. But by using the same interface as a bucket, it can be used for many other reasons:

- Dev work fast and free (normally buckets cost money).
- Create a testing environment.
- Copying from a local folder to a bucket or the reverse easily.
- Having a local cache from the bucket from which you serve the files.
- You just prefer the Bucket interface to the `fs` or similar.
- Sandboxed, since your code can only manipulate that folder. You can no longer do `rm -rf /`.

The interface is similar to other buckets:

```js
import FileBucket 'bucket/fs';

const fs = FileBucket('./demo/');

fs.upload('./public/favicon.png', '/favicon.png');
// Copied to "./demo/favicon.png"
```

The differences with other buckets are:
- The main argument of the constructor is the local folder to use as a bucket.
- The `url` within files wil be the absolute path, since there's no server by default in your computer. You can, as always, provide a `baseURL` (like, `FileBucket('./demo/', { baseUrl: "http://localhost:2000/" })`) and that'll be used instead to generate absolute URLs.
