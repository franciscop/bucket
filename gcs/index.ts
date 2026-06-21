import { getAccessToken, getMetadataToken } from "../lib/signGCS.ts";
import type { IBucket, BucketInfo } from "../lib/types.ts";
import { GCSFile, type GCSAuth, type GCSObjectMeta } from "./File.ts";

const { GCS_BUCKET: ENV_BUCKET, GCS_ENDPOINT: ENV_ENDPOINT } = process.env;

export interface GCSConfig {
  /** Override the API host (falls back to `GCS_ENDPOINT`). Use for the
   * fake-gcs-server emulator, e.g. `http://localhost:4443`. */
  endpoint?: string;
  /** Skip authentication entirely, required by emulators that don't verify
   * tokens (falls back to `GCS_ANONYMOUS=true`). */
  anonymous?: boolean;
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
    const clientEmail = json.client_email ?? "";
    const privateKey = json.private_key?.replace(/\\n/g, "\n");
    return { clientEmail, privateKey };
  }

  // Individual environment variables, for some platforms (Vercel, Railway, etc.)
  const clientEmail = process.env.GCS_CLIENT_EMAIL;
  const privateKey = process.env.GCS_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (clientEmail && privateKey) {
    return { clientEmail, privateKey };
  }

  // GCP metadata server: Cloud Run, GKE, Compute Engine, etc.
  return null;
}

class GCSBucket implements IBucket {
  readonly type = "GCS";
  #bucket: string;
  #endpoint: string;
  #anonymous: boolean;
  #authPromise: Promise<GCSAuth>;
  #cachedToken: string | null = null;
  #tokenExpiry = 0;

  constructor(bucket: string, config: GCSConfig = {}) {
    this.#bucket = bucket;
    this.#endpoint = (
      config.endpoint ||
      ENV_ENDPOINT ||
      "https://storage.googleapis.com"
    ).replace(/\/$/, "");
    this.#anonymous = config.anonymous ?? process.env.GCS_ANONYMOUS === "true";
    this.#authPromise = loadAuth();
  }

  async accessToken(): Promise<string> {
    if (this.#anonymous) return "";
    if (this.#cachedToken && Date.now() < this.#tokenExpiry) {
      return this.#cachedToken;
    }
    const auth = await this.#authPromise;
    this.#cachedToken = auth
      ? await getAccessToken(auth)
      : await getMetadataToken();
    this.#tokenExpiry = Date.now() + 55 * 60 * 1000; // 55 min (tokens last 1h)
    return this.#cachedToken!;
  }

  async info(): Promise<BucketInfo> {
    return {
      type: this.type,
      name: this.#bucket,
      endpoint: `${this.#endpoint}/${this.#bucket}`,
      id: this.#bucket,
    };
  }

  async list(filter?: string | RegExp): Promise<GCSFile[]> {
    const files: GCSFile[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({ maxResults: "1000" });
      if (typeof filter === "string" && filter) params.set("prefix", filter);
      if (pageToken) params.set("pageToken", pageToken);

      const token = await this.accessToken();
      const res = await fetch(
        `${this.#endpoint}/storage/v1/b/${this.#bucket}/o?${params}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) throw new Error(`GCS list error: ${res.status}`);

      const data = (await res.json()) as {
        items?: GCSObjectMeta[];
        nextPageToken?: string;
      };

      for (const item of data.items ?? []) {
        if (filter instanceof RegExp && !filter.test(item.name)) continue;
        files.push(
          new GCSFile(
            item.name,
            this.#bucket,
            this.#authPromise,
            this.#endpoint,
            this.#anonymous,
          ),
        );
      }

      pageToken = data.nextPageToken;
    } while (pageToken);

    return files;
  }

  file(name: string): GCSFile {
    if (!name) throw new Error("No name");
    return new GCSFile(
      name,
      this.#bucket,
      this.#authPromise,
      this.#endpoint,
      this.#anonymous,
    );
  }

  async remove(filter?: string | RegExp): Promise<GCSFile[]> {
    const files = await this.list(filter);
    await Promise.all(files.map((f) => f.remove()));
    return files;
  }

  async count(filter?: string | RegExp): Promise<number> {
    return (await this.list(filter)).length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<GCSFile> {
    for (const file of await this.list()) yield file;
  }
}

/**
 * Create a Google Cloud Storage bucket handle.
 *
 * @param bucket - Bucket name (falls back to `GCS_BUCKET` env var)
 *
 * Credentials are resolved in order:
 * 1. `GOOGLE_APPLICATION_CREDENTIALS` env var → reads the JSON file it points to
 * 2. `GCS_CLIENT_EMAIL` + `GCS_PRIVATE_KEY` env vars
 * 3. GCP metadata server (automatic on Cloud Run, GKE, Compute Engine, etc.)
 *
 * @param config.endpoint - Override the API host (falls back to `GCS_ENDPOINT`),
 *   e.g. `http://localhost:4443` for the fake-gcs-server emulator.
 * @param config.anonymous - Skip authentication (falls back to `GCS_ANONYMOUS`),
 *   required by emulators that don't verify tokens.
 *
 * @example
 * const bucket = GCS("my-bucket");
 * await bucket.file("hello.txt").write("hello");
 */
export default function GCS(
  bucket: string = ENV_BUCKET || "",
  config?: GCSConfig,
): GCSBucket {
  return new GCSBucket(bucket, config);
}

export { GCSBucket, GCSFile };

export type {
  FileInfo,
  BucketInfo,
  FileEntry,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
