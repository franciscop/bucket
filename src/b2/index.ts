import { scope } from "../lib/prefix.ts";
import { throwIfAborted, type ReadOptions } from "../lib/abort.ts";
import { Http } from "../lib/http.ts";
import { origin } from "../lib/config.ts";
import { BaseBucket } from "../lib/base.ts";
import type { BucketInfo } from "../lib/types.ts";
import { B2Session } from "./session.ts";
import { B2File, type B2Context } from "./File.ts";

const {
  B2_BUCKET: ENV_NAME,
  B2_APPLICATION_KEY_ID: ENV_ID,
  B2_APPLICATION_KEY: ENV_KEY,
  B2_PUBLIC_URL: ENV_PUBLIC_URL,
} = process.env;

interface B2Config {
  id?: string;
  secret?: string;
  /** Public origin the bucket is served from, e.g. a CDN in front of B2 (falls
   * back to `B2_PUBLIC_URL`). Used by `file.publicUrl()`. */
  publicUrl?: string;
}

function b2Context(session: B2Session, publicUrl: string): B2Context {
  return {
    provider: "BACKBLAZE",
    prefix: "",
    publicUrl,
    session,
    http: new Http({
      provider: "BACKBLAZE",
      authorize: async (req) => ({
        ...req,
        headers: { Authorization: (await session.get()).token, ...req.headers },
      }),
      // A 401 on a 24h-old token just means it expired. Upload URLs carry a
      // separate token and are sent with `auth: false`, so they never land here.
      refresh: (req) => session.refresh(req.headers.Authorization),
    }),
  };
}

class BackBlazeInstance extends BaseBucket<B2Context, B2File> {
  readonly type = "BACKBLAZE";

  protected make(key: string): B2File {
    return new B2File(key, this.ctx);
  }

  async info(opts?: ReadOptions): Promise<BucketInfo> {
    throwIfAborted(opts?.signal);
    const auth = await this.ctx.session.get();
    return {
      type: this.type,
      name: auth.bucketName,
      url: auth.base,
      id: auth.bucketId,
    };
  }

  protected async *pages(filter?: RegExp, opts?: ReadOptions) {
    const auth = await this.ctx.session.get();
    let nextFileName: string | undefined;
    const s = scope(this.PREFIX, filter);
    do {
      let url =
        auth.apiBase +
        "b2_list_file_names?bucketId=" +
        encodeURIComponent(auth.bucketId);
      if (s.query) url += "&prefix=" + encodeURIComponent(s.query);
      if (nextFileName)
        url += "&startFileName=" + encodeURIComponent(nextFileName);
      const res = await this.ctx.http.get(url, {
        signal: opts?.signal,
        what: "list",
      });
      const data = (await res.json()) as {
        files: { fileName: string }[];
        nextFileName?: string;
      };
      yield data.files
        .filter((f) => s.test(f.fileName))
        .map((f) => this.make(f.fileName));
      nextFileName = data.nextFileName;
    } while (nextFileName);
  }
}

/**
 * Create a Backblaze B2 bucket handle.
 *
 * @param name - Bucket name (falls back to `B2_BUCKET` env var)
 * @param opts.id - Application Key ID (falls back to `B2_APPLICATION_KEY_ID`)
 * @param opts.secret - Application Key (falls back to `B2_APPLICATION_KEY`)
 * @param opts.publicUrl - Public origin for `file.publicUrl()` (falls back to `B2_PUBLIC_URL`)
 *
 * @example
 * const bucket = BackBlaze("my-bucket", { id: "keyId", secret: "appKey" });
 * await bucket.file("hello.txt").write("hello");
 */
export default function BackBlaze(
  name: string = ENV_NAME || "",
  {
    id = ENV_ID || "",
    secret = ENV_KEY || "",
    publicUrl = ENV_PUBLIC_URL || "",
  }: B2Config = {},
): BackBlazeInstance {
  const session = new B2Session(id, secret, name);
  const ctx = b2Context(session, origin(publicUrl));
  return new BackBlazeInstance(ctx);
}
