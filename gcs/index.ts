import { getAccessToken, getMetadataToken } from "../lib/signGCS.ts";
import BucketError from "../lib/BucketError.ts";
import { fileKey, scope, folderKey } from "../lib/prefix.ts";
import type { Bucket, BucketInfo } from "../lib/types.ts";
import { GCSFile, type GCSAuth, type GCSObjectMeta } from "./File.ts";

const { GCS_BUCKET: ENV_BUCKET, GCS_URL: ENV_URL } = process.env;

export interface GCSConfig {
  /** Override the API host (falls back to `GCS_URL`). Use for the
   * fake-gcs-server emulator, e.g. `http://localhost:4443`. */
  url?: string;
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

class GCSBucket implements Bucket {
  readonly type = "GCS";
  #bucket: string;
  #url: string;
  #anonymous: boolean;
  #auth: Promise<GCSAuth>;
  #cachedToken: string | null = null;
  #tokenExpiry = 0;
  PREFIX = "";

  constructor(bucket: string, config: GCSConfig = {}) {
    this.#bucket = bucket;
    this.#url = (
      config.url ||
      ENV_URL ||
      "https://storage.googleapis.com"
    ).replace(/\/$/, "");
    this.#anonymous = config.anonymous ?? process.env.GCS_ANONYMOUS === "true";
    this.#auth = loadAuth();
  }

  async accessToken(): Promise<string> {
    if (this.#anonymous) return "";
    if (this.#cachedToken && Date.now() < this.#tokenExpiry) {
      return this.#cachedToken;
    }
    const auth = await this.#auth;
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
      url: `${this.#url}/${this.#bucket}`,
      id: this.#bucket,
    };
  }

  async *#pages(filter?: RegExp): AsyncGenerator<GCSFile[]> {
    let pageToken: string | undefined;
    const s = scope(this.PREFIX, filter);

    do {
      const params = new URLSearchParams({ maxResults: "1000" });
      if (s.query) params.set("prefix", s.query);
      if (pageToken) params.set("pageToken", pageToken);

      const token = await this.accessToken();
      const res = await fetch(
        `${this.#url}/storage/v1/b/${this.#bucket}/o?${params}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok)
        throw new BucketError(`GCS list error: ${res.status}`, {
          provider: "GCS",
          status: res.status,
        });

      const data = (await res.json()) as {
        items?: GCSObjectMeta[];
        nextPageToken?: string;
      };

      const page: GCSFile[] = [];
      for (const item of data.items ?? []) {
        if (!s.test(item.name)) continue;
        page.push(
          new GCSFile(
            item.name,
            this.#bucket,
            this.#auth,
            this.#url,
            this.#anonymous,
            this.PREFIX,
          ),
        );
      }
      yield page;

      pageToken = data.nextPageToken;
    } while (pageToken);
  }

  async *scan(filter?: RegExp): AsyncGenerator<GCSFile> {
    for await (const page of this.#pages(filter)) yield* page;
  }

  async list(filter?: RegExp): Promise<GCSFile[]> {
    const files: GCSFile[] = [];
    for await (const page of this.#pages(filter)) files.push(...page);
    return files;
  }

  file(name: string): GCSFile {
    if (!name) throw new Error("No name");
    return new GCSFile(
      fileKey(this.PREFIX, name),
      this.#bucket,
      this.#auth,
      this.#url,
      this.#anonymous,
      this.PREFIX,
    );
  }

  folder(path: string): GCSBucket {
    const b = new GCSBucket(this.#bucket, {
      url: this.#url,
      anonymous: this.#anonymous,
    });
    b.#auth = this.#auth;
    b.PREFIX = folderKey(this.PREFIX, path);
    return b;
  }

  async remove(filter?: RegExp): Promise<GCSFile[]> {
    const files = await this.list(filter);
    await Promise.all(files.map((f) => f.remove()));
    return files;
  }

  async count(filter?: RegExp): Promise<number> {
    return (await this.list(filter)).length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<GCSFile> {
    yield* this.scan();
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
 * @param config.url - Override the API host (falls back to `GCS_URL`),
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

export type {
  Bucket,
  BucketFile,
  FileInfo,
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
