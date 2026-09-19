import { sha1hex } from "../lib/webcrypto.ts";
import { destKey } from "../lib/prefix.ts";
import metaFromHeaders from "../lib/meta.ts";
import { publicUrlFrom } from "../lib/publicUrl.ts";
import { throwIfAborted, type ReadOptions } from "../lib/abort.ts";
import BucketError from "../lib/BucketError.ts";
import { rangeHeader, rangeSize } from "../lib/range.ts";
import { metaHeaders } from "../lib/writeMeta.ts";
import { BaseFile, expiresIn, type FileContext } from "../lib/base.ts";
import type { ChunkedTarget } from "../lib/chunkedWritable.ts";
import type {
  BucketFile,
  BucketInfo,
  FileInfo,
  WriteOptions,
} from "../lib/types.ts";

export interface B2UploadAuth {
  uploadUrl: string;
  authorizationToken: string;
}

export interface B2Context extends FileContext {
  info(): Promise<BucketInfo>;
  fetch(url: string, options?: RequestInit): Promise<Response>;
  /** Part size for chunked uploads, resolved from the account's auth. */
  partSize(): Promise<number>;
  apiBase(): string;
}

export class B2File extends BaseFile<B2Context> {
  // The download-by-name URL, only known once the bucket has authenticated.
  async #downloadUrl(): Promise<string> {
    const bucket = await this.ctx.info();
    return bucket.url + "file/" + bucket.name + "/" + this.path;
  }

  // `ctx.fetch` throws on any non-2xx (a range GET returns 206).
  protected async fetch(opts?: ReadOptions): Promise<Response> {
    const rh = this.range && rangeHeader(this.range);
    return this.ctx.fetch(await this.#downloadUrl(), {
      ...(rh ? { headers: { Range: rh } } : {}),
      signal: opts?.signal,
    });
  }

  async info(opts?: ReadOptions): Promise<FileInfo | null> {
    throwIfAborted(opts?.signal);
    // B2 has no metadata-by-name endpoint, but a HEAD on the download-by-name
    // URL returns it in headers. `ctx.fetch` throws on any non-2xx, so a
    // missing file (404) surfaces as a throw; per the documented contract
    // info()/exists() never throw, so any failure means "does not exist".
    let res: Response;
    try {
      res = await this.ctx.fetch(await this.#downloadUrl(), {
        method: "HEAD",
        signal: opts?.signal,
      });
    } catch (err) {
      // An abort is a real failure, not "does not exist".
      if (err instanceof BucketError && err.code === "ABORTED") throw err;
      return null;
    }
    const ts = res.headers.get("x-bz-upload-timestamp");
    return {
      size: rangeSize(
        this.range,
        Number(res.headers.get("content-length") ?? 0),
      ),
      type: res.headers.get("content-type"),
      modified: ts ? new Date(Number(ts)) : new Date(),
      version: res.headers.get("x-bz-file-id"),
      metadata: metaFromHeaders(res.headers, "x-bz-info-", (k) =>
        k.startsWith("b2-"),
      ),
    };
  }

  // Detect from the extension like every other provider; fall back to B2's
  // server-side auto-detection ("b2/x-auto") only for unknown extensions.
  #type(options: WriteOptions): string {
    return this.meta(options).type ?? "b2/x-auto";
  }

  #fileInfo(options: WriteOptions): Record<string, string> {
    return metaHeaders(this.meta(options), {
      cacheControl: "b2-cache-control",
      disposition: "b2-content-disposition",
      metaPrefix: "",
    });
  }

  async #api(name: string, body: unknown, signal?: AbortSignal) {
    return this.ctx.fetch(this.ctx.apiBase() + name, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  protected async put(data: Buffer, options: WriteOptions): Promise<void> {
    const bucket = await this.ctx.info();
    const res = await this.ctx.fetch(
      this.ctx.apiBase() + "b2_get_upload_url?bucketId=" + bucket.id,
      { signal: options.signal },
    );
    const auth = (await res.json()) as B2UploadAuth;
    const headers: Record<string, string> = {
      Authorization: auth.authorizationToken,
      "X-Bz-File-Name": this.path,
      "X-Bz-Content-Sha1": await sha1hex(data),
      "Content-Length": String(data.length),
      "Content-Type": this.#type(options),
    };
    for (const [k, v] of Object.entries(this.#fileInfo(options)))
      headers[`X-Bz-Info-${k}`] = v;
    const res2 = await this.ctx.fetch(auth.uploadUrl, {
      body: data as unknown as BodyInit,
      method: "POST",
      headers,
      signal: options.signal,
    });
    await res2.json();
  }

  // B2 large-file upload: b2_start_large_file → b2_upload_part × n →
  // b2_finish_large_file, cancelling on failure so no orphan parts remain.
  protected target(
    options: WriteOptions,
  ): ChunkedTarget<{ fileId: string }, string> {
    return {
      partSize: () => this.ctx.partSize(),
      single: (data) => this.put(data, options),
      start: async () => {
        const bucket = await this.ctx.info();
        const res = await this.#api(
          "b2_start_large_file",
          {
            bucketId: bucket.id,
            fileName: this.path,
            contentType: this.#type(options),
            fileInfo: this.#fileInfo(options),
          },
          options.signal,
        );
        return (await res.json()) as { fileId: string };
      },
      part: async (ctx, n, data) => {
        const urlRes = await this.ctx.fetch(
          this.ctx.apiBase() + "b2_get_upload_part_url?fileId=" + ctx.fileId,
          { signal: options.signal },
        );
        const auth = (await urlRes.json()) as B2UploadAuth;
        const sha1 = await sha1hex(data);
        const res = await this.ctx.fetch(auth.uploadUrl, {
          method: "POST",
          body: data as unknown as BodyInit,
          headers: {
            Authorization: auth.authorizationToken,
            "X-Bz-Part-Number": String(n),
            "Content-Length": String(data.length),
            "X-Bz-Content-Sha1": sha1,
          },
          signal: options.signal,
        });
        await res.json();
        return sha1;
      },
      finish: async (ctx, parts) => {
        const res = await this.#api(
          "b2_finish_large_file",
          { fileId: ctx.fileId, partSha1Array: parts },
          options.signal,
        );
        await res.json();
      },
      abort: async (ctx) => {
        // No signal: this cancels an already-aborted upload, so it has to run
        // or the parts stay open and billed.
        const res = await this.#api("b2_cancel_large_file", {
          fileId: ctx.fileId,
        });
        await res.json();
      },
    };
  }

  // B2 has no server-side copy: stream the bytes through.
  async copyTo(dest: string | BucketFile, opts?: ReadOptions) {
    throwIfAborted(opts?.signal);
    if (typeof dest !== "string") return dest.write(this, opts);
    return this.at(destKey(this.ctx.prefix, dest, this.name)).write(this, opts);
  }

  async remove(opts?: ReadOptions): Promise<this> {
    throwIfAborted(opts?.signal);
    const bucket = await this.ctx.info();
    // Hide, never delete: B2 is always versioned, and deleting the newest
    // version would both destroy it and uncover the one before it. Hiding
    // stops the path resolving and keeps the history for lifecycle rules.
    // A move relies on this too: it must never destroy history that removing
    // the same file would have kept.
    await this.#api(
      "b2_hide_file",
      { bucketId: bucket.id, fileName: this.path },
      opts?.signal,
    ).catch((e: Error) => {
      // An abort is a real failure, not an already-hidden no-op
      if (e instanceof BucketError && e.code === "ABORTED") throw e;
      // Already hidden, or never there: a no-op, and no second hide marker
      if (!/file_not_present|no_such_file/.test(e.message)) throw e;
    });
    return this;
  }

  protected async canonicalUrl() {
    const bucket = await this.ctx.info();
    return publicUrlFrom(`${bucket.url}file/${bucket.name}`, this.path);
  }

  async signedUrl(opts: { expires: number | string }): Promise<string> {
    const bucket = await this.ctx.info();
    const res = await this.#api("b2_get_download_authorization", {
      bucketId: bucket.id,
      fileNamePrefix: this.path,
      validDurationInSeconds: Math.ceil(expiresIn(opts)),
    });
    const { authorizationToken } = (await res.json()) as {
      authorizationToken: string;
    };
    return `${await this.#downloadUrl()}?Authorization=${encodeURIComponent(authorizationToken)}`;
  }

  // B2 uploads need auth headers, so a standalone upload URL cannot exist.
  async uploadUrl(_opts: { expires: number | string }): Promise<null> {
    return null;
  }
}
