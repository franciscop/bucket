import FileSystem from "../fs/index.ts";
import BackBlaze from "../b2/index.ts";
import S3 from "../s3/index.ts";
import GCS from "../gcs/index.ts";
import Azure from "../azure/index.ts";
import CloudflareR2 from "../r2/index.ts";
import type { Bucket } from "../lib/types.ts";

export type BucketEntry = {
  bucket: Bucket;
};

const buckets: Record<string, BucketEntry> = {};

// ── Always available ──────────────────────────────────────────────────────────

buckets["FileSystem"] = {
  bucket: FileSystem("./fs/test/"),
};

// ── Real buckets: they hit the network or an emulator, so they are opt-in. ───
// Set EXPENSIVE=true (plus the matching credentials / endpoint, see .env.sample)
// to run them. Without EXPENSIVE only the FileSystem suite runs.

if (process.env.EXPENSIVE === "true") {
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
      process.env.GCS_URL) // emulator (fake-gcs-server, anonymous)
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
    process.env.R2_URL &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY
  ) {
    buckets["R2"] = { bucket: CloudflareR2() };
  }
}

// Filter to a specific bucket for debugging, e.g. BUCKET=FileSystem bun test
const only = process.env.BUCKET;
if (only) {
  for (const key of Object.keys(buckets)) {
    if (key !== only) delete buckets[key];
  }
}

export default buckets;
