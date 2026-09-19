import { getAccessToken, getMetadataToken } from "../lib/signGCS.ts";
import { scope } from "../lib/prefix.ts";
import { throwIfAborted, type ReadOptions } from "../lib/abort.ts";
import { Http } from "../lib/http.ts";
import { BaseBucket } from "../lib/base.ts";
import type { BucketInfo } from "../lib/types.ts";
import {
  GCSFile,
  type GCSAuth,
  type GCSContext,
  type GCSObjectMeta,
} from "./File.ts";

const {
  GCS_BUCKET: ENV_BUCKET,
  GCS_URL: ENV_URL,
  GCS_PUBLIC_URL: ENV_PUBLIC_URL,
} = process.env;

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

async function loadAuth(): Promise<GCSAuth> {
  // Service account or google credentials (`gcloud auth application-default login`)
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath) {
    const { readFileSync } = await import("node:fs");
    const json = JSON.parse(readFileSync(credPath, "utf-8")) as {
      client_email: string;
      private_key: string;
    };
    return {
      clientEmail: json.client_email ?? "",
      privateKey: json.private_key?.replace(/\\n/g, "\n"),
    };
  }
  // Individual environment variables, for some platforms (Vercel, Railway, etc.)
  const clientEmail = process.env.GCS_CLIENT_EMAIL;
  const privateKey = process.env.GCS_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (clientEmail && privateKey) return { clientEmail, privateKey };
  // GCP metadata server: Cloud Run, GKE, Compute Engine, etc.
  return null;
}

/** Caches the OAuth token. Lives in the context, so folders share one. */
function tokenCache(auth: Promise<GCSAuth>, anonymous: boolean) {
  let token: string | null = null;
  let expiry = 0;
  return async (): Promise<string> => {
    if (anonymous) return "";
    if (token && Date.now() < expiry) return token;
    const resolved = await auth;
    token = resolved
      ? await getAccessToken(resolved)
      : await getMetadataToken();
    expiry = Date.now() + 55 * 60 * 1000; // 55 min (tokens last 1h)
    return token;
  };
}

function gcsContext(bucket: string, config: GCSConfig = {}): GCSContext {
  const auth = loadAuth();
  const anonymous = config.anonymous ?? process.env.GCS_ANONYMOUS === "true";
  const token = tokenCache(auth, anonymous);
  return {
    provider: "GCS",
    prefix: "",
    publicUrl: (config.publicUrl ?? ENV_PUBLIC_URL ?? "").replace(/\/+$/, ""),
    bucket,
    auth,
    anonymous,
    url: (config.url || ENV_URL || "https://storage.googleapis.com").replace(
      /\/$/,
      "",
    ),
    http: new Http({
      provider: "GCS",
      authorize: async (req) => {
        const bearer = await token();
        // A resumable session URI is itself the credential, so it is left
        // alone; emulators take unauthenticated requests too.
        if (!bearer) return req;
        return {
          ...req,
          headers: { Authorization: `Bearer ${bearer}`, ...req.headers },
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
      const res = await this.ctx.http.send(
        "GET",
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
  config?: GCSConfig,
): GCSBucket {
  return new GCSBucket(gcsContext(bucket, config));
}

export type {
  Bucket,
  BucketFile,
  FileInfo,
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
