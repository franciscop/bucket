// Bucket: unified API for file storage services.
// One entry point: every provider is a named export, under its service name.
import FS from "./fs/index.ts";
import S3 from "./s3/index.ts";
import R2 from "./r2/index.ts";
import GCS from "./gcs/index.ts";
import Azure from "./azure/index.ts";
import B2 from "./b2/index.ts";
import Memory from "./memory/index.ts";

export { FS, S3, R2, GCS, Azure, B2, Memory };

// Spelled-out aliases for the three whose short name is an abbreviation. The
// docs use the short names throughout; these exist so the full name works if
// you prefer reading it.
export { FS as FileSystem, R2 as CloudflareR2, B2 as BackBlaze };

export { default as BucketError } from "./lib/BucketError.ts";

/** Extension to MIME type, the table `write()` detects content types with. */
export { default as mimes } from "./lib/mimes.ts";

// The same providers as one object, for code that picks a backend at runtime.
export default { FS, S3, R2, GCS, Azure, B2, Memory };

export type { BucketErrorCode } from "./lib/BucketError.ts";
export type {
  Bucket,
  BucketFile,
  FileInfo,
  BucketInfo,
  ReadOptions,
  WriteContent,
  WriteOptions,
} from "./lib/types.ts";
