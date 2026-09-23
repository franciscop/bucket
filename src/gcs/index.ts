import { getAccessToken, getMetadataToken } from "../lib/signGCS.ts";
import { scope } from "../lib/prefix.ts";
import { throwIfAborted, type ReadOptions } from "../lib/abort.ts";
import { Http } from "../lib/http.ts";
import BucketError from "../lib/BucketError.ts";
import { origin } from "../lib/config.ts";
import { fs } from "../lib/node.ts";
import { TokenCache } from "../lib/TokenCache.ts";
import { BaseBucket } from "../lib/base.ts";
import type { BucketInfo } from "../lib/types.ts";
import {
  GCSFile,
  type GCSAuth,
  type GCSContext,
  type GCSObjectMeta,
} from "./File.ts";
import { env } from "../lib/env.ts";

const {
  GCS_BUCKET: ENV_BUCKET,
  GCS_URL: ENV_URL,
  GCS_ANONYMOUS: ENV_ANONYMOUS,
  GCS_PUBLIC_URL: ENV_PUBLIC_URL,
} = env;

export interface GCSConfig {
  /** Override the API host (falls back to `GCS_URL`). Use for the
   * fake-gcs-server emulator, e.g. `http://localhost:4443`. */
  url?: string;
  /** Skip authentication entirely, required by emulators that don't verify
   * tokens (falls back to `GCS_ANONYMOUS=true`). */
  anonymous?: boolean;
  /** Public origin the bucket is served from, e.g. a CDN domain (falls back
   * to `GCS_PUBLIC_URL`). Used by `file.publicUrl()`. */
  publicUrl?: string;
}

/** The options and env, resolved into one place. */
interface GCSResolved {
  bucket: string;
  url: string;
  anonymous: boolean;
  publicUrl: string;
}

function resolveConfig(bucket: string, config: GCSConfig): GCSResolved {
  return {
    bucket,
    url: origin(config.url || ENV_URL || "https://storage.googleapis.com"),
    anonymous: config.anonymous ?? ENV_ANONYMOUS === "true",
    publicUrl: origin(config.publicUrl ?? ENV_PUBLIC_URL),
  };
}

async function loadAuth(): Promise<GCSAuth> {
  // Service account or google credentials (`gcloud auth application-default login`)
  const credPath = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath) {
    if (!fs)
      throw new BucketError(
        "GOOGLE_APPLICATION_CREDENTIALS needs Node's fs module to read the file",
        { code: "INVALID_CONFIG" },
      );
    const json = JSON.parse(fs.readFileSync(credPath, "utf-8")) as {
      client_email: string;
      private_key: string;
    };
    return {
      clientEmail: json.client_email ?? "",
      privateKey: json.private_key?.replace(/\\n/g, "\n"),
    };
  }
  // Individual environment variables, for some platforms (Vercel, Railway, etc.)
  const clientEmail = env.GCS_CLIENT_EMAIL;
  const privateKey = env.GCS_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (clientEmail && privateKey) return { clientEmail, privateKey };
  // GCP metadata server: Cloud Run, GKE, Compute Engine, etc.
  return null;
}

function gcsContext(config: GCSResolved): GCSContext {
  const auth = loadAuth();
  // Awaited only on first use, so a bad credentials file must not crash first.
  auth.catch(() => {});
  // Tokens last an hour; refresh five minutes early.
  const token = new TokenCache<string>(async () => {
    const resolved = await auth;
    const value = resolved
      ? await getAccessToken(resolved)
      : await getMetadataToken();
    return [value, Date.now() + 55 * 60 * 1000];
  });
  return {
    provider: "GCS",
    prefix: "",
    publicUrl: config.publicUrl,
    bucket: config.bucket,
    auth,
    anonymous: config.anonymous,
    url: config.url,
    http: new Http({
      provider: "GCS",
      authorize: async (req) => {
        // Emulators take unauthenticated requests; a resumable session URI
        // is itself the credential either way.
        if (config.anonymous) return req;
        return {
          ...req,
          headers: {
            Authorization: `Bearer ${await token.get()}`,
            ...req.headers,
          },
        };
      },
    }),
  };
}

class GCSBucket extends BaseBucket<GCSContext, GCSFile> {
  readonly type = "GCS";

  protected make(key: string): GCSFile {
    return new GCSFile(key, this.ctx);
  }

  async info(opts?: ReadOptions): Promise<BucketInfo> {
    throwIfAborted(opts?.signal);
    const { bucket, url } = this.ctx;
    return {
      type: this.type,
      name: bucket,
      url: `${url}/${bucket}`,
      id: bucket,
    };
  }

  protected async *pages(filter?: RegExp, opts?: ReadOptions) {
    let pageToken: string | undefined;
    const s = scope(this.PREFIX, filter);
    do {
      const params = new URLSearchParams({ maxResults: "1000" });
      if (s.query) params.set("prefix", s.query);
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this.ctx.http.get(
        `${this.ctx.url}/storage/v1/b/${this.ctx.bucket}/o?${params}`,
        { signal: opts?.signal, what: "list" },
      );
      const data = (await res.json()) as {
        items?: GCSObjectMeta[];
        nextPageToken?: string;
      };
      yield (data.items ?? [])
        .filter((item) => s.test(item.name))
        .map((item) => this.make(item.name));
      pageToken = data.nextPageToken;
    } while (pageToken);
  }
}

/**
 * Create a Google Cloud Storage bucket handle.
 *
 * Credentials are resolved in this order:
 * 1. `GOOGLE_APPLICATION_CREDENTIALS` env var → reads the JSON file it points to
 * 2. `GCS_CLIENT_EMAIL` + `GCS_PRIVATE_KEY` env vars
 * 3. GCP metadata server (Cloud Run, GKE, Compute Engine)
 *
 * @param bucket - Bucket name (falls back to `GCS_BUCKET` env var)
 * @param config.url - Override the API host (falls back to `GCS_URL`)
 * @param config.anonymous - Skip authentication, for emulators (falls back to `GCS_ANONYMOUS`)
 * @param config.publicUrl - Public origin for `file.publicUrl()` (falls back to `GCS_PUBLIC_URL`)
 *
 * @example
 * const bucket = GCS("my-bucket");
 * await bucket.file("hello.txt").write("hello");
 */
export default function GCS(
  bucket: string = ENV_BUCKET || "",
  config: GCSConfig = {},
): GCSBucket {
  const resolved = resolveConfig(bucket, config);
  const ctx = gcsContext(resolved);
  return new GCSBucket(ctx);
}
