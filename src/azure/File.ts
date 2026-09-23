import { presignAzure } from "../lib/signAzure.ts";
import BucketError from "../lib/BucketError.ts";
import { encodeKey } from "../lib/encodeKey.ts";
import { toBytes } from "../lib/bytes.ts";
import { toBase64 } from "../lib/webcrypto.ts";
import metaFromHeaders, { metaExtras } from "../lib/meta.ts";
import { throwIfAborted, type ReadOptions } from "../lib/abort.ts";
import type { Http } from "../lib/http.ts";
import { rangeHeader, rangeSize } from "../lib/range.ts";
import { metaHeaders } from "../lib/writeMeta.ts";
import { BaseFile, expiresIn, type FileContext } from "../lib/base.ts";
import type { ChunkedTarget } from "../lib/chunkedWritable.ts";
import type { FileInfo, WriteOptions } from "../lib/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    return `${this.ctx.url}/${this.ctx.container}/${encodeKey(path)}`;
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
      provider: this.provider,
      type: "x-ms-blob-content-type",
      cacheControl: "x-ms-blob-cache-control",
      disposition: "x-ms-blob-content-disposition",
      metaPrefix: "x-ms-meta-",
    });
  }

  protected async put(data: Uint8Array, options: WriteOptions): Promise<void> {
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
      toBase64(toBytes(String(n).padStart(6, "0")));
    // Built up front, so bad metadata fails before any block is sent.
    const headers = this.#blobHeaders(options);
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
            headers,
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
    const res = await this.ctx.http.put(this.#url(key), {
      headers: { "x-ms-copy-source": this.#blobUrl() },
      signal: opts?.signal,
      what: "COPY",
    });
    // A large copy can finish after the response: wait, or a move would
    // delete the source mid-copy.
    let status = res.headers.get("x-ms-copy-status");
    for (
      let wait = 100;
      status === "pending";
      wait = Math.min(wait * 2, 2000)
    ) {
      await sleep(wait);
      throwIfAborted(opts?.signal);
      const head = await this.ctx.http.head(this.#url(key), {
        signal: opts?.signal,
        what: "copy status",
      });
      status = head.headers.get("x-ms-copy-status");
    }
    if (status && status !== "success")
      throw new BucketError(`Azure copy failed: ${status}`, {
        provider: this.provider,
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
    return presignAzure({
      url: this.ctx.url,
      account: this.ctx.account,
      container: this.ctx.container,
      path: this.path,
      key: auth.key,
      permission: perm,
      expires: expiresIn(opts),
    });
  }

  signedUrl(opts: { expires: number | string }) {
    return this.#presign("r", opts);
  }

  uploadUrl(opts: { expires: number | string }) {
    return this.#presign("w", opts);
  }
}
