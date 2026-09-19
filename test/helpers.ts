// Shared test utilities. The provider suites all mock `fetch` the same way and
// all want to assert on `err.code`; keeping one copy means they stay consistent
// about restoring the global afterwards.
import { afterEach, beforeEach } from "bun:test";

export type FetchHandler = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

/** Replaces global fetch for one test. Pair with `restoreFetch()`. */
export function mockFetch(handler: FetchHandler): void {
  globalThis.fetch = handler as unknown as typeof fetch;
}

/** Saves and restores global fetch around every test in the current suite. */
export function restoreFetch(): void {
  let original: typeof fetch;
  beforeEach(() => {
    original = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });
}

export function makeResponse(
  body: string | null,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

/** The `code` of the BucketError `fn` threw, or undefined if it resolved. */
export async function codeOf(fn: () => unknown): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

/** The error `fn` threw, or null if it resolved. */
export async function caught(fn: () => unknown): Promise<any> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return null;
}
