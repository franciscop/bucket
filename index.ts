// Bucket — unified API for file storage services
// Main entry point

export { default as FileSystem } from "./fs/index.ts";
export { default as BackBlaze } from "./b2/index.ts";
export { default as BackBlazeV2 } from "./b2/index2.ts";
export { default as CloudflareR2 } from "./r2/index.ts";
export { default as S3 } from "./s3/index.ts";

export type {
  IBucket,
  IBucketFile,
  FileInfo,
  BucketInfo,
  FileEntry,
  WriteContent,
  S3Auth,
  S3Request,
} from "./lib/types.ts";
