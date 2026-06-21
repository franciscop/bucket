import "dotenv/config";

import cleanAndSignS3 from "../lib/cleanAndSignS3.ts";
import type { IBucket, BucketInfo, S3Auth, S3Request } from "../lib/types.ts";
import { R2File, type R2BucketContext } from "./File.ts";

const {
  R2_ENDPOINT: ENV_ENDPOINT,
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
}

function extractBucketName(endpoint: string): string {
  try {
    return new URL(endpoint).pathname.replace(/^\//, "").split("/")[0] ?? "";
  } catch {
    return "";
  }
}

function extractTags(xmlStr: string, tag: string): string[] {
  const results: string[] = [];
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xmlStr)) !== null) results.push(match[1]);
  return results;
}

function getTag(xmlStr: string, tag: string): string {
  return extractTags(xmlStr, tag)[0] ?? "";
}

class CloudflareR2Bucket implements IBucket {
  readonly type = "R2";
  private endpoint: string;
  private auth: S3Auth;
  private bucketName: string;

  constructor(
    endpoint: string = ENV_ENDPOINT || "",
    {
      id = ENV_ID || "",
      secret = ENV_KEY || "",
      region = ENV_REGION || "auto",
      sessionToken = ENV_SESSION_TOKEN,
    }: R2Config = {},
  ) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.bucketName = extractBucketName(this.endpoint);
    this.auth = { id, secret, region, sessionToken };
  }

  private makeUrl(path: string = ""): string {
    const cleanPath = path ? (path.startsWith("/") ? path : "/" + path) : "";
    return this.endpoint + cleanPath;
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
    cleanAndSignS3(req, this.auth);
    return fetch(url, {
      method: method.toUpperCase(),
      headers: req.headers,
      body: options.body as BodyInit | undefined,
    });
  }

  async info(): Promise<BucketInfo> {
    return {
      id: this.auth.id,
      name: this.bucketName,
      type: this.type,
      endpoint: this.endpoint,
    };
  }

  async list(filter?: string | RegExp): Promise<R2File[]> {
    const files: R2File[] = [];
    let token: string | undefined;

    do {
      const url = new URL(this.makeUrl(""));
      url.searchParams.set("list-type", "2");
      if (filter && typeof filter === "string")
        url.searchParams.set("prefix", filter);
      if (token) url.searchParams.set("continuation-token", token);

      const req: S3Request = {
        url: url.toString(),
        method: "get",
        headers: {},
      };
      cleanAndSignS3(req, this.auth);

      const res = await fetch(url.toString(), {
        method: "GET",
        headers: req.headers,
      });
      if (!res.ok) throw new Error(`R2 list error: ${res.status}`);

      const xmlStr = await res.text();
      for (const item of extractTags(xmlStr, "Contents")) {
        const key = getTag(item, "Key");
        if (filter instanceof RegExp && !filter.test(key)) continue;
        files.push(this.file(key));
      }

      token =
        getTag(xmlStr, "IsTruncated") === "true"
          ? getTag(xmlStr, "NextContinuationToken")
          : undefined;
    } while (token);

    return files;
  }

  async remove(filter?: string | RegExp): Promise<R2File[]> {
    const files = await this.list(filter);
    if (!files.length) return [];

    const deleted: R2File[] = [];
    for (let i = 0; i < files.length; i += 1000) {
      const batch = files.slice(i, i + 1000);
      const body =
        `<Delete>` +
        batch.map((f) => `<Object><Key>${f.path}</Key></Object>`).join("") +
        `</Delete>`;

      const url = new URL(this.makeUrl(""));
      url.searchParams.set("delete", "");
      const req: S3Request = {
        url: url.toString(),
        method: "post",
        headers: { "content-md5": "" },
        body,
      };
      cleanAndSignS3(req, this.auth);

      const res = await fetch(url.toString(), {
        method: "POST",
        headers: req.headers,
        body,
      });
      if (!res.ok) throw new Error(`R2 delete error: ${res.status}`);

      const xmlStr = await res.text();
      const keys = extractTags(xmlStr, "Deleted").map((d) => getTag(d, "Key"));
      deleted.push(...batch.filter((f) => keys.includes(f.path)));
    }

    return deleted;
  }

  file(name: string): R2File {
    if (!name) throw new Error("No name");
    const ctx: R2BucketContext = {
      makeUrl: (p) => this.makeUrl(p),
      doRequest: (m, p, opts) => this.doRequest(m, p, opts),
      getAuth: () => this.auth,
      bucketName: this.bucketName,
      endpoint: this.endpoint,
    };
    return new R2File(name, ctx);
  }

  async count(filter?: string | RegExp): Promise<number> {
    return (await this.list(filter)).length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<R2File> {
    for (const file of await this.list()) yield file;
  }
}

/**
 * Create a Cloudflare R2 bucket handle.
 *
 * @param endpoint - Full R2 endpoint URL: `https://<account>.r2.cloudflarestorage.com/<bucket>`
 *   (falls back to `R2_ENDPOINT` env var)
 * @param config.id - Access Key ID (falls back to `R2_ACCESS_KEY_ID`)
 * @param config.secret - Secret Access Key (falls back to `R2_SECRET_ACCESS_KEY`)
 * @param config.sessionToken - Session token for temporary credentials (falls back to `R2_SESSION_TOKEN`)
 * @param config.region - Region, default `"auto"` (falls back to `R2_REGION`)
 *
 * @example
 * const bucket = CloudflareR2("https://abc.r2.cloudflarestorage.com/my-bucket", {
 *   id: "keyId",
 *   secret: "secretKey",
 * });
 * await bucket.file("hello.txt").write("hello");
 */
export default function CloudflareR2(
  endpoint?: string,
  config?: R2Config,
): CloudflareR2Bucket {
  return new CloudflareR2Bucket(endpoint, config);
}

export { CloudflareR2Bucket, R2File };
