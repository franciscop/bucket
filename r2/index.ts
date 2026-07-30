import cleanAndSignS3 from "../lib/cleanAndSignS3.ts";
import encodeS3Path from "../lib/encodeS3Path.ts";
import { escapeXml, unescapeXml, extractTags, getTag } from "../lib/xml.ts";
import { sha256base64 } from "../lib/webcrypto.ts";
import BucketError from "../lib/BucketError.ts";
import { fileKey, scope, folderKey } from "../lib/prefix.ts";
import type { Bucket, BucketInfo, S3Auth, S3Request } from "../lib/types.ts";
import { R2File, type R2BucketContext } from "./File.ts";

const {
  R2_BUCKET: ENV_BUCKET,
  R2_URL: ENV_URL,
  R2_ACCESS_KEY_ID: ENV_ID,
  R2_SECRET_ACCESS_KEY: ENV_KEY,
  R2_SESSION_TOKEN: ENV_SESSION_TOKEN,
  R2_REGION: ENV_REGION,
} = process.env;

export interface R2Config {
  id?: string;
  secret?: string;
  region?: string;
  sessionToken?: string;
  /** Full R2 endpoint URL, including the bucket name at the end:
   * `https://<account>.r2.cloudflarestorage.com/<bucket>` (falls back to
   * `R2_URL`). */
  url?: string;
}

function extractBucketName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, "").split("/")[0] ?? "";
  } catch {
    return "";
  }
}

class CloudflareR2Bucket implements Bucket {
  readonly type = "R2";
  private url: string;
  #auth: S3Auth;
  private bucketName: string;
  PREFIX = "";

  constructor(
    name: string = ENV_BUCKET || "",
    {
      id = ENV_ID || "",
      secret = ENV_KEY || "",
      region = ENV_REGION || "auto",
      sessionToken = ENV_SESSION_TOKEN,
      url = ENV_URL || "",
    }: R2Config = {},
  ) {
    this.url = url.replace(/\/$/, "");
    // R2's request URL already ends with the bucket path, so the two must agree.
    const derived = extractBucketName(this.url);
    if (name && derived && name !== derived)
      throw new Error(
        `R2 bucket name "${name}" does not match the bucket in url "${this.url}"`,
      );
    this.bucketName = name || derived;
    this.#auth = { id, secret, region, sessionToken };
  }

  private makeUrl(path: string = ""): string {
    const cleanPath = path ? (path.startsWith("/") ? path : "/" + path) : "";
    // Encode the key so the sent path matches what the signer canonicalizes.
    return this.url + encodeS3Path(cleanPath);
  }

  private async doRequest(
    method: string,
    path: string,
    options: { body?: string | Buffer; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const url = this.makeUrl(path);
    const req: S3Request = {
      url,
      method: method.toLowerCase(),
      headers: { ...(options.headers || {}) },
      body: options.body,
    };
    await cleanAndSignS3(req, this.#auth);
    const res = await fetch(url, {
      method: method.toUpperCase(),
      headers: req.headers,
      body: options.body as BodyInit | undefined,
    });
    if (process.env.DIAG)
      console.error(`[R2] ${method.toUpperCase()} ${url} -> ${res.status}`);
    return res;
  }

  async info(): Promise<BucketInfo> {
    return {
      type: this.type,
      name: this.bucketName,
      url: this.url,
      id: this.#auth.id,
    };
  }

  private async *pages(filter?: RegExp): AsyncGenerator<R2File[]> {
    let token: string | undefined;
    const s = scope(this.PREFIX, filter);

    do {
      const url = new URL(this.makeUrl(""));
      url.searchParams.set("list-type", "2");
      if (s.query) url.searchParams.set("prefix", s.query);
      if (token) url.searchParams.set("continuation-token", token);

      const req: S3Request = {
        url: url.toString(),
        method: "get",
        headers: {},
      };
      await cleanAndSignS3(req, this.#auth);

      const res = await fetch(url.toString(), {
        method: "GET",
        headers: req.headers,
      });
      if (!res.ok)
        throw new BucketError(`R2 list error: ${res.status}`, {
          provider: "R2",
          status: res.status,
        });

      const xmlStr = await res.text();
      const page: R2File[] = [];
      for (const item of extractTags(xmlStr, "Contents")) {
        const key = unescapeXml(getTag(item, "Key"));
        if (!s.test(key)) continue;
        page.push(this.handle(key));
      }
      yield page;

      token =
        getTag(xmlStr, "IsTruncated") === "true"
          ? getTag(xmlStr, "NextContinuationToken")
          : undefined;
    } while (token);
  }

  async *scan(filter?: RegExp): AsyncGenerator<R2File> {
    for await (const page of this.pages(filter)) yield* page;
  }

  async list(filter?: RegExp): Promise<R2File[]> {
    const files: R2File[] = [];
    for await (const page of this.pages(filter)) files.push(...page);
    return files;
  }

  async remove(filter?: RegExp): Promise<R2File[]> {
    const files = await this.list(filter);
    if (!files.length) return [];

    const deleted: R2File[] = [];
    for (let i = 0; i < files.length; i += 1000) {
      const batch = files.slice(i, i + 1000);
      const body =
        `<Delete>` +
        batch
          .map((f) => `<Object><Key>${escapeXml(f.path)}</Key></Object>`)
          .join("") +
        `</Delete>`;

      const url = new URL(this.makeUrl(""));
      url.searchParams.set("delete", "");
      // DeleteObjects requires a body integrity header; S3/R2/MinIO 400 without it.
      const req: S3Request = {
        url: url.toString(),
        method: "post",
        headers: { "x-amz-checksum-sha256": await sha256base64(body) },
        body,
      };
      await cleanAndSignS3(req, this.#auth);

      const res = await fetch(url.toString(), {
        method: "POST",
        headers: req.headers,
        body,
      });
      if (!res.ok)
        throw new BucketError(
          `R2 delete error: ${res.status} ${await res.text()}`,
          { provider: "R2", status: res.status },
        );

      const xmlStr = await res.text();
      const keys = extractTags(xmlStr, "Deleted").map((d) =>
        unescapeXml(getTag(d, "Key")),
      );
      deleted.push(...batch.filter((f) => keys.includes(f.path)));
    }

    return deleted;
  }

  private handle(path: string): R2File {
    const ctx: R2BucketContext = {
      makeUrl: (p) => this.makeUrl(p),
      doRequest: (m, p, opts) => this.doRequest(m, p, opts),
      getAuth: () => this.#auth,
      bucketName: this.bucketName,
      url: this.url,
      prefix: this.PREFIX,
    };
    return new R2File(path, ctx);
  }

  file(name: string): R2File {
    if (!name) throw new Error("No name");
    return this.handle(fileKey(this.PREFIX, name));
  }

  folder(path: string): CloudflareR2Bucket {
    const b = new CloudflareR2Bucket(this.bucketName, { url: this.url });
    b.#auth = this.#auth;
    b.PREFIX = folderKey(this.PREFIX, path);
    return b;
  }

  async count(filter?: RegExp): Promise<number> {
    return (await this.list(filter)).length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<R2File> {
    yield* this.scan();
  }
}

/**
 * Create a Cloudflare R2 bucket handle.
 *
 * @param name - Bucket name (falls back to `R2_BUCKET` env var)
 * @param config.id - Access Key ID (falls back to `R2_ACCESS_KEY_ID`)
 * @param config.secret - Secret Access Key (falls back to `R2_SECRET_ACCESS_KEY`)
 * @param config.sessionToken - Session token for temporary credentials (falls back to `R2_SESSION_TOKEN`)
 * @param config.region - Region, default `"auto"` (falls back to `R2_REGION`)
 * @param config.url - Full R2 endpoint URL, including the bucket name at the end:
 *   `https://<account>.r2.cloudflarestorage.com/<bucket>` (falls back to `R2_URL`)
 *
 * @example
 * const bucket = CloudflareR2("my-bucket", {
 *   id: "keyId",
 *   secret: "secretKey",
 *   url: "https://abc.r2.cloudflarestorage.com/my-bucket",
 * });
 * await bucket.file("hello.txt").write("hello");
 */
export default function CloudflareR2(
  name?: string,
  config?: R2Config,
): CloudflareR2Bucket {
  return new CloudflareR2Bucket(name, config);
}

export type {
  Bucket,
  BucketFile,
  FileInfo,
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
