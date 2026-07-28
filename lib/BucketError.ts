// A structured error thrown by every backend. `code` is a normalized, uppercase
// identifier you can branch on the same way across providers (and the
// filesystem); `status` is the raw HTTP status when the failure came from an
// HTTP response. The message stays human-readable and provider-specific.
// INVALID_PATH is raised client-side, before any provider is involved, when a
// path would escape the bucket or folder it is resolved against.

export type BucketErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "UNAUTHORIZED"
  | "CONFLICT"
  | "INVALID_PATH"
  | "UNKNOWN";

export interface BucketErrorOptions {
  /** Provider that produced the error, e.g. "S3", "GCS", "FILESYSTEM".
   * Absent for errors raised before reaching a provider (INVALID_PATH). */
  provider?: string;
  /** Raw HTTP status, when the error came from an HTTP response */
  status?: number;
  /** Normalized code; derived from `status` when omitted */
  code?: BucketErrorCode;
  /** The underlying error or response that caused this */
  cause?: unknown;
}

const CODE_BY_STATUS: Record<number, BucketErrorCode> = {
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
};

export default class BucketError extends Error {
  readonly provider?: string;
  readonly status?: number;
  readonly code: BucketErrorCode;

  constructor(message: string, options: BucketErrorOptions) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "BucketError";
    this.provider = options.provider;
    this.status = options.status;
    this.code =
      options.code ??
      (options.status === undefined
        ? "UNKNOWN"
        : (CODE_BY_STATUS[options.status] ?? "UNKNOWN"));
  }
}
