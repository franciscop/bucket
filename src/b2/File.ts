import { sha1hex } from "../lib/webcrypto.ts";
import metaFromHeaders, { metaExtras } from "../lib/meta.ts";
import { publicUrlFrom } from "../lib/publicUrl.ts";
import { throwIfAborted, type ReadOptions } from "../lib/abort.ts";
import type { Http, SendOptions } from "../lib/http.ts";
import { rangeHeader, rangeSize } from "../lib/range.ts";
import { metaHeaders } from "../lib/writeMeta.ts";
import { BaseFile, expiresIn, type FileContext } from "../lib/base.ts";
import type { ChunkedTarget } from "../lib/chunkedWritable.ts";
import type { FileInfo, WriteOptions } from "../lib/types.ts";
import type { B2Session } from "./session.ts";

interface B2UploadAuth {
  uploadUrl: string;
  authorizationToken: string;
}

export interface B2Context extends FileContext {
  session: B2Session;
  http: Http;
}

export class B2File extends BaseFile<B2Context> {
  // The download-by-name URL, only known once the account has authorized.
  async #downloadUrl(): Promise<string> {
    const auth = await this.ctx.session.get();
    return auth.base + "file/" + auth.bucketName + "/" + this.path;
  }

  // A JSON API call; `name` is the B2 operation, e.g. "b2_hide_file".
  async #api(name: string, body: unknown, options: SendOptions = {}) {
    const auth = await this.ctx.session.get();
    return this.ctx.http.post(auth.apiBase + name, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      what: name,
      ...options,
    });
  }

  // Asks for an upload URL, which comes with its own single-use token.
  async #uploadAuth(
    query: string,
    signal?: AbortSignal,
  ): Promise<B2UploadAuth> {
    const auth = await this.ctx.session.get();
    const res = await this.ctx.http.get(auth.apiBase + query, {
      signal,
      what: "upload url",
    });
    return (await res.json()) as B2UploadAuth;
  }

  // The upload URL's token replaces the account token, so the request goes
  // out as-is: a 401 there means a stale upload URL, not an expired account.
  async #upload(
    auth: B2UploadAuth,
    data: Buffer,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await this.ctx.http.post(auth.uploadUrl, {
      auth: false,
      body: data,
      headers: {
        Authorization: auth.authorizationToken,
        "X-Bz-Content-Sha1": await sha1hex(data),
        "Content-Length": String(data.length),
        ...headers,
      },
      signal,
      what: "upload",
    });
    await res.json();
  }

  protected async fetch(opts?: ReadOptions): Promise<Response> {
    const rh = this.range && rangeHeader(this.range);
    return this.ctx.http.get(await this.#downloadUrl(), {
      headers: rh ? { Range: rh } : {},
      signal: opts?.signal,
      what: "GET",
    });
  }

  async info(opts?: ReadOptions): Promise<FileInfo | null> {
    throwIfAborted(opts?.signal);
    // B2 has no metadata-by-name endpoint, but a HEAD on the download-by-name
    // URL returns it in headers.
    const res = await this.ctx.http.head(await this.#downloadUrl(), {
      signal: opts?.signal,
      ok: [404],
      what: "HEAD",
    });
    if (res.status === 404) return null;
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
      ...metaExtras(
        res.headers.get("x-bz-info-b2-cache-control"),
        res.headers.get("x-bz-info-b2-content-disposition"),
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

  protected async put(data: Buffer, options: WriteOptions): Promise<void> {
    const auth = await this.ctx.session.get();
    const upload = await this.#uploadAuth(
      "b2_get_upload_url?bucketId=" + auth.bucketId,
      options.signal,
    );
    const headers: Record<string, string> = {
      "X-Bz-File-Name": this.path,
      "Content-Type": this.#type(options),
    };
    for (const [k, v] of Object.entries(this.#fileInfo(options)))
      headers[`X-Bz-Info-${k}`] = v;
    await this.#upload(upload, data, headers, options.signal);
  }

  // B2 large-file upload: b2_start_large_file → b2_upload_part × n →
  // b2_finish_large_file, cancelling on failure so no orphan parts remain.
  protected target(
    options: WriteOptions,
  ): ChunkedTarget<{ fileId: string }, string> {
    return {
      // B2's recommendedPartSize is ~100 MB, far too much to buffer per part,
      // so use our own 8 MiB and only defer to B2 when its minimum is higher.
      partSize: async () => {
        const auth = await this.ctx.session.get();
        return Math.max(auth.absoluteMinimumPartSize, 8 * 1024 * 1024);
      },
      single: (data) => this.put(data, options),
      start: async () => {
        const auth = await this.ctx.session.get();
        const res = await this.#api(
          "b2_start_large_file",
          {
            bucketId: auth.bucketId,
            fileName: this.path,
            contentType: this.#type(options),
            fileInfo: this.#fileInfo(options),
          },
          { signal: options.signal },
        );
        return (await res.json()) as { fileId: string };
      },
      part: async (ctx, n, data) => {
        const upload = await this.#uploadAuth(
          "b2_get_upload_part_url?fileId=" + ctx.fileId,
          options.signal,
        );
        const sha1 = await sha1hex(data);
        await this.#upload(
          upload,
          data,
          { "X-Bz-Part-Number": String(n) },
          options.signal,
        );
        return sha1;
      },
      finish: async (ctx, parts) => {
        const res = await this.#api(
          "b2_finish_large_file",
          { fileId: ctx.fileId, partSha1Array: parts },
          { signal: options.signal },
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
  protected async copy(key: string, opts?: ReadOptions): Promise<void> {
    await this.at(key).write(this, opts);
  }

  protected async delete(opts?: ReadOptions): Promise<void> {
    const auth = await this.ctx.session.get();
    // Hide, never delete: B2 is always versioned, and deleting the newest
    // version would both destroy it and uncover the one before it. Hiding
    // stops the path resolving and keeps the history for lifecycle rules.
    // A move relies on this too: it must never destroy history that removing
    // the same file would have kept.
    const res = await this.#api(
      "b2_hide_file",
      { bucketId: auth.bucketId, fileName: this.path },
      { signal: opts?.signal, raw: true },
    );
    if (!res.ok) {
      // Already hidden, or never there: a no-op, and no second hide marker
      const { code } = (await res.json().catch(() => ({}))) as {
        code?: string;
      };
      if (!/file_not_present|no_such_file/.test(code ?? ""))
        this.check(res, "b2_hide_file");
    }
  }

  protected async canonicalUrl() {
    const auth = await this.ctx.session.get();
    return publicUrlFrom(`${auth.base}file/${auth.bucketName}`, this.path);
  }

  async signedUrl(opts: { expires: number | string }): Promise<string> {
    const auth = await this.ctx.session.get();
    const res = await this.#api("b2_get_download_authorization", {
      bucketId: auth.bucketId,
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
