// Bucket: unified API for file storage services
// Main entry point

import S3 from "./s3/index.ts";
export default S3();
export { default as FileSystem } from "./fs/index.ts";
export { default as BackBlaze } from "./b2/index.ts";
export { default as CloudflareR2 } from "./r2/index.ts";
export { default as S3 } from "./s3/index.ts";
export { default as GCS } from "./gcs/index.ts";
export { default as Azure } from "./azure/index.ts";

export type {
  IBucket,
  IBucketFile,
  FileInfo,
  BucketInfo,
  FileEntry,
  WriteContent,
  WriteOptions,
  S3Auth,
  S3Request,
} from "./lib/types.ts";
