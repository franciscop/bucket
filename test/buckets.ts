import FileSystem, { FileSystemBucket } from "../fs/index.ts";
import BackBlaze, { BackBlazeInstance } from "../b2/index.ts";
import S3, { S3Bucket } from "../s3/index.ts";
import GCS, { GCSBucket } from "../gcs/index.ts";
import Azure, { AzureBucket } from "../azure/index.ts";
import CloudflareR2, { CloudflareR2Bucket } from "../r2/index.ts";

type AnyBucket =
  | FileSystemBucket
  | BackBlazeInstance
  | S3Bucket
  | GCSBucket
  | AzureBucket
  | CloudflareR2Bucket;

export type BucketEntry = {
  bucket: AnyBucket;
  // True when the bucket is pre-seeded with the 8 test files under test/bucket/
  // Reading tests (data.txt, nero.jpg, etc.) only run when this is true.
  seeded: boolean;
};

const buckets: Record<string, BucketEntry> = {};

// ── Always available ──────────────────────────────────────────────────────────

buckets["FileSystem"] = {
  bucket: FileSystem("./test/bucket/"),
  seeded: true,
};

// ── Cloud buckets: only loaded when credentials are present ──────────────────
// To run these, set the corresponding env vars (see .env.sample).
// The remote bucket must also contain the same 8 test files as ./test/bucket/
// for the seeded reading tests to pass.

if (
  process.env.B2_BUCKET &&
  process.env.B2_APPLICATION_KEY_ID &&
  process.env.B2_APPLICATION_KEY
) {
  buckets["BackBlaze"] = {
    bucket: BackBlaze(),
    seeded: Boolean(process.env.B2_SEEDED)  };
}

if (
  process.env.AWS_BUCKET &&
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY
) {
  buckets["S3"] = {
    bucket: S3(),
    seeded: Boolean(process.env.AWS_SEEDED)  };
}

if (
  process.env.GCS_BUCKET &&
  (process.env.GCS_CLIENT_EMAIL || process.env.GCS_CREDENTIALS)
) {
  buckets["GCS"] = {
    bucket: GCS(),
    seeded: Boolean(process.env.GCS_SEEDED)  };
}

if (
  process.env.AZURE_ACCOUNT &&
  process.env.AZURE_CONTAINER &&
  process.env.AZURE_KEY
) {
  buckets["Azure"] = {
    bucket: Azure(),
    seeded: Boolean(process.env.AZURE_SEEDED)  };
}

if (
  process.env.R2_ENDPOINT &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY
) {
  buckets["R2"] = {
    bucket: CloudflareR2(),
    seeded: Boolean(process.env.R2_SEEDED)  };
}

// Filter to a specific bucket for debugging, e.g. BUCKET=FileSystem bun test
const only = process.env.BUCKET;
if (only) {
  for (const key of Object.keys(buckets)) {
    if (key !== only) delete buckets[key];
  }
}

export default buckets;
