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
};

const buckets: Record<string, BucketEntry> = {};

// ── Always available ──────────────────────────────────────────────────────────

buckets["FileSystem"] = {
  bucket: FileSystem("./fs/test/"),
};

// ── Cloud buckets: only loaded when credentials are present ──────────────────
// To run these, set the corresponding env vars (see .env.sample).

if (
  process.env.B2_BUCKET &&
  process.env.B2_APPLICATION_KEY_ID &&
  process.env.B2_APPLICATION_KEY
) {
  buckets["BackBlaze"] = { bucket: BackBlaze() };
}

if (
  process.env.AWS_BUCKET &&
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY
) {
  buckets["S3"] = { bucket: S3() };
}

if (
  process.env.GCS_BUCKET &&
  (process.env.GCS_CLIENT_EMAIL ||
    process.env.GCS_CREDENTIALS ||
    process.env.GCS_ENDPOINT) // emulator (fake-gcs-server, anonymous)
) {
  buckets["GCS"] = { bucket: GCS() };
}

if (
  process.env.AZURE_ACCOUNT &&
  process.env.AZURE_CONTAINER &&
  process.env.AZURE_KEY
) {
  buckets["Azure"] = { bucket: Azure() };
}

if (
  process.env.R2_ENDPOINT &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY
) {
  buckets["R2"] = { bucket: CloudflareR2() };
}

// Filter to a specific bucket for debugging, e.g. BUCKET=FileSystem bun test
const only = process.env.BUCKET;
if (only) {
  for (const key of Object.keys(buckets)) {
    if (key !== only) delete buckets[key];
  }
}

export default buckets;
