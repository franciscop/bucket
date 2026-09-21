import { presignAzure } from "../lib/signAzure.ts";
import metaFromHeaders, { metaExtras } from "../lib/meta.ts";
import { throwIfAborted, type ReadOptions } from "../lib/abort.ts";
import type { Http } from "../lib/http.ts";
import { rangeHeader, rangeSize } from "../lib/range.ts";
import { metaHeaders } from "../lib/writeMeta.ts";
import { BaseFile, expiresIn, type FileContext } from "../lib/base.ts";
import type { ChunkedTarget } from "../lib/chunkedWritable.ts";
import type { FileInfo, WriteOptions } from "../lib/types.ts";

// Azure signs the canonicalized resource with the path as sent, and the WHATWG
// URL parser percent-encodes "<" and ">" in URL paths, so encode them up
// front and sign that same form (mirrors lib/encodeS3Path for S3/R2).
export const encodePath = (path: string): string =>
  path.replace(
    /[<>]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );

export type AzureFileAuth =
  | { type: "shared-key"; key: string }
  | { type: "managed-identity"; getToken: () => Promise<string> };

export interface AzureContext extends FileContext {
  account: string;
  container: string;
  url: string;
  auth: AzureFileAuth;
  http: Http;
}

export class AzureFile extends BaseFile<AzureContext> {
  #blobUrl(path = this.path): string {
    return `${this.ctx.url}/${this.ctx.container}/${encodePath(path)}`;
  }

  #url(path = this.path, params?: Record<string, string>): string {
    const base = this.#blobUrl(path);
    return params ? `${base}?${new URLSearchParams(params)}` : base;
  }

  protected async fetch(opts?: ReadOptions): Promise<Response> {
    // Azure's SharedKey StringToSign has no slot for a standard `Range`
    // header, but it does sign every `x-ms-*` header, so use `x-ms-range`.
    const rh = this.range && rangeHeader(this.range);
    return this.ctx.http.get(this.#url(), {
      headers: rh ? { "x-ms-range": rh } : {},
      signal: opts?.signal,
      what: "GET",
    });
  }

  async info(opts?: ReadOptions): Promise<FileInfo | null> {
    throwIfAborted(opts?.signal);
    const res = await this.ctx.http.head(this.#url(), {
      signal: opts?.signal,
      ok: [404],
      what: "HEAD",
    });
    if (res.status === 404) return null;
    return {
      size: rangeSize(
        this.range,
        parseInt(res.headers.get("content-length") ?? "0", 10),
      ),
      type: res.headers.get("content-type"),
      modified: new Date(res.headers.get("last-modified") ?? Date.now()),
      version: res.headers.get("x-ms-version-id"),
      metadata: metaFromHeaders(res.headers, "x-ms-meta-"),
      ...metaExtras(
        res.headers.get("cache-control"),
        res.headers.get("content-disposition"),
      ),
    };
  }

  #blobHeaders(options: WriteOptions): Record<string, string> {
    return metaHeaders(this.meta(options), {
      type: "x-ms-blob-content-type",
      cacheControl: "x-ms-blob-cache-control",
      disposition: "x-ms-blob-content-disposition",
      metaPrefix: "x-ms-meta-",
    });
  }

  protected async put(data: Buffer, options: WriteOptions): Promise<void> {
    await this.ctx.http.put(this.#url(), {
      headers: { "x-ms-blob-type": "BlockBlob", ...this.#blobHeaders(options) },
      body: data,
      signal: options.signal,
      what: "PUT",
    });
  }

  // Azure block upload: Put Block × n, then Put Block List to commit. There
  // is no server-side session to open or abort; uncommitted blocks are
  // garbage-collected by Azure after about a week.
  protected target(options: WriteOptions): ChunkedTarget<string[], string> {
    // Block ids must be base64 and all the same length, so pad the index.
    const blockId = (n: number) =>
      Buffer.from(String(n).padStart(6, "0")).toString("base64");
    return {
      partSize: 8 * 1024 * 1024,
      single: (data) => this.put(data, options),
      start: async () => [],
      part: async (ids, n, data) => {
        const id = blockId(n);
        const res = await this.ctx.http.put(
          this.#url(this.path, { comp: "block", blockid: id }),
          { body: data, signal: options.signal, what: "block" },
        );
        await res.text();
        ids.push(id);
        return id;
      },
      finish: async (ids) => {
        const res = await this.ctx.http.put(
          this.#url(this.path, { comp: "blocklist" }),
          {
            headers: this.#blobHeaders(options),
            body:
              `<?xml version="1.0" encoding="utf-8"?><BlockList>` +
              ids.map((id) => `<Latest>${id}</Latest>`).join("") +
              `</BlockList>`,
            signal: options.signal,
            what: "block commit",
          },
        );
        await res.text();
      },
      abort: async () => {},
    };
  }

  protected async copy(key: string, opts?: ReadOptions): Promise<void> {
    await this.ctx.http.put(this.#url(key), {
      headers: { "x-ms-copy-source": this.#blobUrl() },
      signal: opts?.signal,
      what: "COPY",
    });
  }

  protected async delete(opts?: ReadOptions): Promise<void> {
    // "include" deletes the blob together with its snapshots; without it a
    // blob that has any snapshot refuses to delete at all (409). Versions are
    // untouched either way: this deletes the blob, never a `versionid`.
    await this.ctx.http.delete(this.#url(), {
      headers: { "x-ms-delete-snapshots": "include" },
      signal: opts?.signal,
      ok: [404, 202],
      what: "DELETE",
    });
  }

  protected async canonicalUrl() {
    return this.#blobUrl();
  }

  async #presign(perm: "r" | "w", opts: { expires: number | string }) {
    const auth = this.ctx.auth;
    if (auth.type === "managed-identity") return null;
    return presignAzure(
      this.ctx.account,
      this.ctx.container,
      this.path,
      auth.key,
      perm,
      expiresIn(opts),
    );
  }

  signedUrl(opts: { expires: number | string }) {
    return this.#presign("r", opts);
  }

  uploadUrl(opts: { expires: number | string }) {
    return this.#presign("w", opts);
  }
}
