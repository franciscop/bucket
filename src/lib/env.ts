// Environment variables from whichever runtime provides them: Netlify's
// `Netlify.env`, then `process.env` (Node, Bun, Deno), else empty (browsers).
// `process.env` is used live rather than copied, so later changes are seen.
const runtime = globalThis as typeof globalThis & {
  Netlify?: { env: { toObject(): Record<string, string> } };
};

export const env: Record<string, string | undefined> =
  runtime.Netlify?.env.toObject() ?? globalThis.process?.env ?? {};
