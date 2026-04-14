#!/usr/bin/env bun
// Bun build script — bundles all TypeScript source into a single index.js
export {};

const result = await Bun.build({
  entrypoints: ["./index.ts"],
  outdir: "./",
  naming: "index.js",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "none",
});

if (!result.success) {
  console.error("Build failed:");
  for (const message of result.logs) {
    console.error(message);
  }
  process.exit(1);
}

const output = result.outputs[0];
console.log(`Built: ${output.path} (${(output.size / 1024).toFixed(1)} KB)`);
