// Shared by every provider factory while it resolves its options and env
// into a config.
import BucketError from "./BucketError.ts";

export const invalidConfig = (message: string): never => {
  throw new BucketError(message, { code: "INVALID_CONFIG" });
};

/** A URL as an origin to append paths to: no trailing slash, "" when unset. */
export const origin = (url?: string): string => (url ?? "").replace(/\/+$/, "");
