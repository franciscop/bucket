import { presignGCS } from "../lib/signGCS.ts";
import BucketError from "../lib/BucketError.ts";
import { publicUrlFrom } from "../lib/publicUrl.ts";
import { throwIfAborted, type ReadOptions } from "../lib/abort.ts";
import type { Http } from "../lib/http.ts";
import { metaExtras } from "../lib/meta.ts";
import { rangeHeader, rangeSize } from "../lib/range.ts";
import { BaseFile, expiresIn, type FileContext } from "../lib/base.ts";
import type { ChunkedTarget } from "../lib/chunkedWritable.ts";
import type { FileInfo, WriteOptions } from "../lib/types.ts";

export interface GCSObjectMeta {
  name: string;
  contentType: string;
  size: string;
  updated: string;
  generation?: string;
  cacheControl?: string;
  contentDisposition?: string;
  mediaLink: string;
  metadata?: Record<string, string>;
}

export type GCSAuth = { clientEmail: string; privateKey: string } | null;

export interface GCSContext extends FileContext {
  bucket: string;
  auth: Promise<GCSAuth>;
  url: string;
  anonymous: boolean;
  http: Http;
}

export class GCSFile extends BaseFile<GCSContext> {
  #apiUrl(path = this.path): string {
    return `${this.ctx.url}/storage/v1/b/${this.ctx.bucket}/o/${encodeURIComponent(path)}`;
  }

  #uploadUrl(query: string): string {
    return `${this.ctx.url}/upload/storage/v1/b/${this.ctx.bucket}/o?${query}`;
  }

  protected async fetch(opts?: ReadOptions): Promise<Response> {
    const rh = this.range && rangeHeader(this.range);
    return this.ctx.http.get(`${this.#apiUrl()}?alt=media`, {
      headers: rh ? { Range: rh } : {},
      signal: opts?.signal,
      what: "GET",
    });
  }

  async info(opts?: ReadOptions): Promise<FileInfo | null> {
    throwIfAborted(opts?.signal);
    const res = await this.ctx.http.get(this.#apiUrl(), {
      signal: opts?.signal,
      ok: [404],
      what: "info",
    });
    if (res.status === 404) return null;
    const meta = (await res.json()) as GCSObjectMeta;
    return {
      size: rangeSize(this.range, parseInt(meta.size, 10)),
      type: meta.contentType,
      modified: new Date(meta.updated),
      version: meta.generation ?? null,
      metadata: meta.metadata ?? {},
      ...metaExtras(meta.cacheControl, meta.contentDisposition),
    };
  }

  // The JSON metadata GCS wants on a multipart or resumable upload.
  #meta(options: WriteOptions): Record<string, unknown> {
    const meta = this.meta(options);
    const out: Record<string, unknown> = { name: this.path };
    if (meta.type) out.contentType = meta.type;
    if (meta.cacheControl) out.cacheControl = meta.cacheControl;
    if (meta.disposition) out.contentDisposition = meta.disposition;
    if (Object.keys(meta.metadata).length) out.metadata = meta.metadata;
    return out;
  }

  protected async put(data: Buffer, options: WriteOptions): Promise<void> {
    const { type, cacheControl, disposition, metadata } = this.meta(options);
    const hasMeta =
      cacheControl || disposition || Object.keys(metadata).length > 0;
    if (!hasMeta) {
      await this.ctx.http.post(
        this.#uploadUrl(
          `uploadType=media&name=${encodeURIComponent(this.path)}`,
        ),
        {
          headers: type ? { "Content-Type": type } : {},
          body: data,
          signal: options.signal,
          what: "PUT",
        },
      );
      return;
    }
    // Metadata needs the multipart/related form: a JSON part, then the bytes.
    const boundary = `_b_${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(this.#meta(options))}\r\n--${boundary}\r\nContent-Type: ${type ?? "application/octet-stream"}\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    await this.ctx.http.post(this.#uploadUrl("uploadType=multipart"), {
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
      signal: options.signal,
      what: "PUT",
    });
  }

  // GCS resumable upload: open a session (the URI is a capability, no auth
  // needed on the chunks), then PUT sequential ranges. The final chunk
  // carries the total size in Content-Range, which completes the object, so
  // finish() is a no-op. Chunks must be 256 KiB multiples; 8 MiB is.
  protected target(
    options: WriteOptions,
  ): ChunkedTarget<{ uri: string; offset: number }, number> {
    return {
      partSize: 8 * 1024 * 1024,
      single: (data) => this.put(data, options),
      start: async () => {
        const res = await this.ctx.http.post(
          this.#uploadUrl(
            `uploadType=resumable&name=${encodeURIComponent(this.path)}`,
          ),
          {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(this.#meta(options)),
            signal: options.signal,
            what: "resumable start",
          },
        );
        await res.text();
        const uri = res.headers.get("location");
        if (!uri)
          throw new BucketError("GCS resumable start: no session URI", {
            provider: "GCS",
          });
        return { uri, offset: 0 };
      },
      part: async (ctx, n, data, isLast) => {
        const to = ctx.offset + data.length - 1;
        const total = isLast ? String(ctx.offset + data.length) : "*";
        // The session URI carries its own credentials, so this goes out
        // unsigned; 308 means "resume incomplete", expected on every
        // non-final chunk.
        const res = await this.ctx.http.put(ctx.uri, {
          headers: { "Content-Range": `bytes ${ctx.offset}-${to}/${total}` },
          body: data,
          signal: options.signal,
          ok: [308],
          what: "resumable part",
        });
        await res.text();
        ctx.offset += data.length;
        return n;
      },
      finish: async () => {},
      abort: async (ctx) => {
        // No signal: this cleans up an already-aborted upload, so it has to
        // run or the session is left open.
        await fetch(ctx.uri, { method: "DELETE" }).catch(() => {});
      },
    };
  }

  protected async copy(key: string, opts?: ReadOptions): Promise<void> {
    await this.ctx.http.post(
      `${this.#apiUrl()}/copyTo/b/${this.ctx.bucket}/o/${encodeURIComponent(key)}`,
      { signal: opts?.signal, what: "COPY" },
    );
  }

  protected async delete(opts?: ReadOptions): Promise<void> {
    // No `generation` parameter: this removes the path, not a specific
    // generation, so on a versioned bucket the prior ones are kept.
    await this.ctx.http.delete(this.#apiUrl(), {
      signal: opts?.signal,
      ok: [404, 204],
      what: "DELETE",
    });
  }

  protected async canonicalUrl() {
    return publicUrlFrom(`${this.ctx.url}/${this.ctx.bucket}`, this.path);
  }

  async #presign(method: "GET" | "PUT", opts: { expires: number | string }) {
    const auth = await this.ctx.auth;
    if (!auth) return null;
    return presignGCS(
      this.ctx.bucket,
      this.path,
      auth,
      method,
      expiresIn(opts),
    );
  }

  signedUrl(opts: { expires: number | string }) {
    return this.#presign("GET", opts);
  }

  uploadUrl(opts: { expires: number | string }) {
    return this.#presign("PUT", opts);
  }
}
