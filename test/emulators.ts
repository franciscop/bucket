// Runs the full integration suite (test/index.test.ts) against local emulators,
// no Docker required. Starts MinIO (S3 + R2), Azurite (Azure) and
// fake-gcs-server (GCS) as child processes, seeds the buckets/container, runs
// the suite, then tears everything down.
//
//   bun --env-file=.env.emulators test/emulators.ts   (see `npm run test:emulators`)
//
// MinIO and fake-gcs-server must be on PATH (see readme "Emulators"); Azurite
// ships as a devDependency, so it is always available after `bun install`.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const procs: ChildProcess[] = [];
const dirs: string[] = [];

function launch(cmd: string, args: string[], env: Record<string, string> = {}) {
  const p = spawn(cmd, args, {
    stdio: "ignore",
    env: { ...process.env, ...env },
  });
  p.on("error", (e) => console.error(`Failed to start "${cmd}": ${e.message}`));
  procs.push(p);
}

// Run a command inheriting stdio/env; resolves with its exit code.
function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: "inherit", env: process.env });
    p.on("exit", (code) => resolve(code ?? 1));
  });
}

function teardown() {
  for (const p of procs) {
    try {
      p.kill("SIGTERM");
    } catch {}
  }
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    teardown();
    process.exit(1);
  });
}

try {
  const minioDir = mkdtempSync(join(tmpdir(), "minio-"));
  const azuriteDir = mkdtempSync(join(tmpdir(), "azurite-"));
  dirs.push(minioDir, azuriteDir);

  // MinIO serves both the S3 and R2 buckets on :9000.
  launch(
    "minio",
    [
      "server",
      minioDir,
      "--address",
      "127.0.0.1:9000",
      "--console-address",
      "127.0.0.1:9001",
    ],
    {
      MINIO_ROOT_USER: process.env.AWS_ACCESS_KEY_ID || "minioadmin",
      MINIO_ROOT_PASSWORD: process.env.AWS_SECRET_ACCESS_KEY || "minioadmin",
    },
  );

  // Azure Blob (devDependency binary).
  launch("./node_modules/.bin/azurite-blob", [
    "--silent",
    "--location",
    azuriteDir,
    "--blobHost",
    "127.0.0.1",
    "--blobPort",
    "10000",
  ]);

  // Google Cloud Storage (in-memory data plane, no auth).
  launch("fake-gcs-server", [
    "-scheme",
    "http",
    "-host",
    "127.0.0.1",
    "-port",
    "4443",
    "-backend",
    "memory",
    "-external-url",
    "http://127.0.0.1:4443",
    "-public-host",
    "127.0.0.1:4443",
  ]);

  // Pass --env-file to the children too: it disables Bun's automatic .env
  // loading, so real cloud credentials in .env can never leak into an emulator
  // run (B2, which has no emulator, is simply excluded instead of hitting the
  // real service).
  const ENV = ["--env-file=.env.emulators"];

  // setup-emulators.ts waits for each server to become reachable before seeding.
  const setup = await run("bun", [...ENV, "test/setup-emulators.ts"]);
  if (setup !== 0) throw new Error("emulator setup failed");

  const code = await run("bun", [
    ...ENV,
    "test",
    "test/index.test.ts",
    "--timeout",
    "30000",
  ]);
  teardown();
  process.exit(code);
} catch (err) {
  console.error(err);
  teardown();
  process.exit(1);
}
