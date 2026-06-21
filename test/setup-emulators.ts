// Creates the buckets/container the integration suite needs inside the local
// emulators (see docker-compose.emulators.yml). Idempotent: existing resources
// are left alone. Each block is gated on its endpoint env var, so it also works
// with only a subset of emulators running.
//
//   bun --env-file=.env.emulators test/setup-emulators.ts

import cleanAndSignS3 from "../lib/cleanAndSignS3.ts";
import { signAzure, accountPathPrefix } from "../lib/signAzure.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  url: string,
  label: string,
  attempts = 60,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fetch(url); // any HTTP response means the server is reachable
      console.log(`✓ ${label} reachable`);
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`${label} never became reachable at ${url}`);
}

const ok = (status: number) => status < 300 || status === 409;

// ── MinIO: create the S3 and R2 buckets (path-style PUT) ─────────────────────
async function createBucket(
  endpoint: string,
  id: string,
  secret: string,
  region: string,
  label: string,
): Promise<void> {
  const req = {
    url: endpoint,
    method: "put",
    headers: {} as Record<string, string>,
  };
  await cleanAndSignS3(req, { id, secret, region });
  const res = await fetch(endpoint, { method: "PUT", headers: req.headers });
  console.log(
    `  ${label} bucket → ${res.status}${ok(res.status) ? " (ok)" : " " + (await res.text())}`,
  );
}

if (process.env.AWS_ENDPOINT) {
  const { protocol, host } = new URL(process.env.AWS_ENDPOINT);
  await waitFor(`${protocol}//${host}/minio/health/live`, "MinIO");
  await createBucket(
    process.env.AWS_ENDPOINT,
    process.env.AWS_ACCESS_KEY_ID || "",
    process.env.AWS_SECRET_ACCESS_KEY || "",
    process.env.AWS_REGION || "us-east-1",
    "S3",
  );
}

if (process.env.R2_ENDPOINT) {
  await createBucket(
    process.env.R2_ENDPOINT,
    process.env.R2_ACCESS_KEY_ID || "",
    process.env.R2_SECRET_ACCESS_KEY || "",
    process.env.R2_REGION || "us-east-1",
    "R2",
  );
}

// ── Azurite: create the blob container (SharedKey PUT) ───────────────────────
if (process.env.AZURE_ENDPOINT) {
  const endpoint = process.env.AZURE_ENDPOINT;
  const account = process.env.AZURE_ACCOUNT || "";
  const key = process.env.AZURE_KEY || "";
  const container = process.env.AZURE_CONTAINER || "";
  await waitFor(endpoint, "Azurite");
  const path = `${accountPathPrefix(endpoint)}/${container}`;
  const headers = await signAzure(
    "PUT",
    path,
    {},
    { account, key },
    { restype: "container" },
  );
  const res = await fetch(`${endpoint}/${container}?restype=container`, {
    method: "PUT",
    headers,
  });
  console.log(
    `  Azure container → ${res.status}${ok(res.status) ? " (ok)" : " " + (await res.text())}`,
  );
}

// ── fake-gcs-server: create the bucket (anonymous JSON API) ──────────────────
if (process.env.GCS_ENDPOINT) {
  const endpoint = process.env.GCS_ENDPOINT.replace(/\/$/, "");
  await waitFor(`${endpoint}/storage/v1/b?project=test`, "fake-gcs-server");
  const res = await fetch(`${endpoint}/storage/v1/b?project=test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: process.env.GCS_BUCKET }),
  });
  console.log(
    `  GCS bucket → ${res.status}${ok(res.status) ? " (ok)" : " " + (await res.text())}`,
  );
}

console.log("Emulator setup complete.");
