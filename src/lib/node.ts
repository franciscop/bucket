// Every Node built-in the library touches, loaded synchronously and optional:
// null on a runtime without `process.getBuiltinModule` (browsers, edge), so
// importing the library never fails and only the code that needs one does
// (the FS provider, the node* stream methods).
const load = (name: string): unknown =>
  globalThis.process?.getBuiltinModule?.(name) ?? null;

export const stream = load("node:stream") as
  typeof import("node:stream") | null;

// Typed as present: FileSystem() refuses to build a bucket when they are not.
export const fs = load("node:fs") as typeof import("node:fs");
export const path = load("node:path") as typeof import("node:path");
export const os = load("node:os") as typeof import("node:os");
export const fsp = fs?.promises;
