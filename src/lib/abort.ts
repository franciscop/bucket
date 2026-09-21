import BucketError from "./BucketError.ts";

/** Options accepted by every method that performs I/O. */
export interface ReadOptions {
  /** Aborts the operation. Rejects with a `BucketError` of code `"ABORTED"`. */
  signal?: AbortSignal;
}

/**
 * The error every aborted operation rejects with. `code` is the stable axis to
 * branch on, while `name` mirrors the signal's own reason so the standard
 * idiom keeps working: a plain abort is an "AbortError", but
 * `AbortSignal.timeout()` is a "TimeoutError", which is how you tell a slow
 * server from a user who navigated away.
 */
export function abortError(signal?: AbortSignal): BucketError {
  const reason = signal?.reason as
    { name?: string; message?: string } | undefined;
  const err = new BucketError(reason?.message || "The operation was aborted", {
    code: "ABORTED",
    cause: reason,
  });
  err.name = reason?.name || "AbortError";
  return err;
}

/** Throws before doing any work when the signal is already aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

/**
 * Normalizes whatever a provider threw: an abort becomes our BucketError, and
 * anything else passes through untouched.
 */
export function rethrow(err: unknown, signal?: AbortSignal): never {
  if (signal?.aborted) throw abortError(signal);
  const name = (err as { name?: string })?.name;
  if (name === "AbortError" || name === "TimeoutError")
    throw abortError(signal);
  throw err;
}

/** Runs `fn`, converting an abort into a `BucketError` with code `"ABORTED"`. */
export async function withAbort<T>(
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  try {
    return await fn();
  } catch (err) {
    rethrow(err, signal);
  }
}
