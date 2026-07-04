// Bucket: unified API for file storage services
// Main entry point

import S3 from "./s3/index.ts";
import type { Bucket } from "./lib/types.ts";

// A ready-to-use S3 bucket from the environment. Typed as the `Bucket`
// interface so the default export has a nameable type in the built d.ts.
const defaultBucket: Bucket = S3();
export default defaultBucket;
export { default as FileSystem } from "./fs/index.ts";
export { default as BackBlaze } from "./b2/index.ts";
export { default as CloudflareR2 } from "./r2/index.ts";
export { default as S3 } from "./s3/index.ts";
export { default as GCS } from "./gcs/index.ts";
export { default as Azure } from "./azure/index.ts";

export type {
  Bucket,
  BucketFile,
  FileInfo,
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "./lib/types.ts";
