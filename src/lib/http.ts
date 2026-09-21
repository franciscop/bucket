// The single path every provider request takes: authorize, send, retry, and
// turn a bad status into a BucketError. Each provider supplies only its own
// `authorize` (SigV4, Azure SharedKey, a bearer token, a B2 session), so the
// abort handling, the retry policy and the error shape are written once.
import BucketError from "./BucketError.ts";
import { withAbort } from "./abort.ts";

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Buffer;
}

/** Fills in a request's auth. May rewrite headers or the url (query signing). */
export type Authorizer = (
  req: HttpRequest,
) => Promise<HttpRequest> | HttpRequest;

export interface SendOptions {
  headers?: Record<string, string>;
  body?: string | Buffer;
  signal?: AbortSignal;
  /** Statuses to accept besides 2xx, e.g. 404 on a delete. */
  ok?: number[];
  /** Label for the error message, e.g. "GET" or "list". */
  what?: string;
  /** Return the response whatever the status, leaving the check to the caller. */
  raw?: boolean;
  /** false sends the request as given: no authorizer and no 401 refresh, for
   * a request that carries its own credential (a B2 upload URL). */
  auth?: boolean;
}

// Transient by nature: the same request a moment later may well succeed.
// A 429 or a 5xx is the server asking to be left alone briefly.
const RETRIABLE = new Set([429, 500, 502, 503, 504]);
// Only replayable methods. Bodies here are always strings or Buffers (a
// chunked upload sends one Buffer per part), so re-sending is always safe.
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Throws unless the response is 2xx or explicitly allowed. */
export function checkStatus(
  res: Response,
  provider: string,
  what: string,
  ...ok: number[]
): Response {
  if (res.ok || ok.includes(res.status)) return res;
  throw new BucketError(`${provider} ${what} error: ${res.status}`, {
    provider,
    status: res.status,
  });
}

export interface HttpOptions {
  /** Label used in error messages and `BucketError.provider`. */
  provider: string;
  authorize: Authorizer;
  /** Extra attempts after a retriable failure. 0 disables retrying. */
  retries?: number;
  /** Called once when an authorized request comes back 401, before it is
   * authorized again and retried. For credentials that expire (a B2 session). */
  refresh?: (req: HttpRequest) => Promise<void>;
}

export class Http {
  #opts: HttpOptions;

  constructor(opts: HttpOptions) {
    this.#opts = opts;
  }

  get(url: string, options?: SendOptions): Promise<Response> {
    return this.send("GET", url, options);
  }

  head(url: string, options?: SendOptions): Promise<Response> {
    return this.send("HEAD", url, options);
  }

  put(url: string, options?: SendOptions): Promise<Response> {
    return this.send("PUT", url, options);
  }

  post(url: string, options?: SendOptions): Promise<Response> {
    return this.send("POST", url, options);
  }

  delete(url: string, options?: SendOptions): Promise<Response> {
    return this.send("DELETE", url, options);
  }

  /** Sends one authorized request, retrying transient failures. The verb
   * methods above are the usual entry; this is for a method held in a variable. */
  async send(
    method: string,
    url: string,
    options: SendOptions = {},
  ): Promise<Response> {
    const { provider, retries = 2, authorize, refresh } = this.#opts;
    const attempts = IDEMPOTENT.has(method.toUpperCase()) ? retries + 1 : 1;
    let attempt = 0;
    let refreshed = false;

    for (;;) {
      if (attempt) {
        // Exponential backoff with jitter, so a fleet of clients retrying the
        // same throttled bucket does not come back in lockstep.
        await sleep(2 ** attempt * 100 * (0.5 + Math.random()));
      }
      // Re-authorize on every attempt: a signature carries a timestamp, and a
      // token may have been refreshed since the last try.
      const plain: HttpRequest = {
        method: method.toUpperCase(),
        url,
        headers: { ...(options.headers ?? {}) },
        body: options.body,
      };
      const req = options.auth === false ? plain : await authorize(plain);
      // Only the transport goes in the try: a bad status is decided below, so
      // that throwing on a 403 can never look like a network failure to retry.
      let res: Response;
      try {
        res = await withAbort(options.signal, () =>
          fetch(req.url, {
            method: req.method,
            headers: req.headers,
            body: req.body as BodyInit | undefined,
            signal: options.signal,
          }),
        );
      } catch (err) {
        // An abort is the caller's decision, never something to retry.
        if (err instanceof BucketError && err.code === "ABORTED") throw err;
        if (++attempt >= attempts) throw err;
        continue;
      }
      if (
        res.status === 401 &&
        refresh &&
        options.auth !== false &&
        !refreshed
      ) {
        refreshed = true;
        await refresh(req);
        continue;
      }
      if (RETRIABLE.has(res.status) && ++attempt < attempts) continue;
      return options.raw
        ? res
        : checkStatus(
            res,
            provider,
            options.what ?? method,
            ...(options.ok ?? []),
          );
    }
  }
}
