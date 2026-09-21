// Every Node built-in the library touches, loaded once and optional: null on
// a runtime without it, so importing the library never fails and only the
// code that needs one does (the FS provider, the node* stream methods). The
// name goes through a variable so the bundler keeps the `node:` prefix.
const load = <T>(name: string): Promise<T | null> =>
  import(name).catch(() => null);

export const stream = await load<typeof import("node:stream")>("node:stream");

// Typed as present: FileSystem() refuses to build a bucket when they are not.
export const fs = (await load("node:fs")) as typeof import("node:fs");
export const path = (await load("node:path")) as typeof import("node:path");
export const os = (await load("node:os")) as typeof import("node:os");
export const fsp = fs?.promises;
