// Bucket: unified API for file storage services
// Main entry point

import FileSystem from "./fs/index.ts";
import S3 from "./s3/index.ts";
import CloudflareR2 from "./r2/index.ts";
import GCS from "./gcs/index.ts";
import Azure from "./azure/index.ts";
import BackBlaze from "./b2/index.ts";

// Every provider under its service name; prefer the subpath imports
// ("bucket/s3", "bucket/fs", ...) when bundle size matters, since this
// namespace pulls in all of them.
export default {
  FS: FileSystem,
  S3,
  R2: CloudflareR2,
  GCS,
  Azure,
  B2: BackBlaze,
};

export { default as FileSystem } from "./fs/index.ts";
export { default as BackBlaze } from "./b2/index.ts";
export { default as CloudflareR2 } from "./r2/index.ts";
export { default as S3 } from "./s3/index.ts";
export { default as GCS } from "./gcs/index.ts";
export { default as Azure } from "./azure/index.ts";
export { default as BucketError } from "./lib/BucketError.ts";

export type { BucketErrorCode } from "./lib/BucketError.ts";
export type {
  Bucket,
  BucketFile,
  FileInfo,
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "./lib/types.ts";
