// S3-protocol multipart upload (AWS S3 and Cloudflare R2 share it):
// CreateMultipartUpload → UploadPart × n → CompleteMultipartUpload, with
// AbortMultipartUpload on any failure so no billed orphan parts remain.

import BucketError from "./BucketError.ts";
import { escapeXml, extractTags, getTag } from "./xml.ts";
import type { ChunkedTarget } from "./chunkedWritable.ts";
import type { Http } from "./http.ts";

export const S3_PART_SIZE = 8 * 1024 * 1024;

export interface S3MultipartOptions {
  provider: string;
  /** The object's URL; each multipart call adds its own query to it. */
  url: string;
  http: Http;
  /** Content headers (type, cache-control, disposition, x-amz-meta-*) set
   * on the create call; S3 applies them to the assembled object. */
  headers: Record<string, string>;
  single: (data: Uint8Array) => Promise<void>;
  /** Cancels the upload. Never passed to abort(), which has to clean up
   * precisely because the signal already fired. */
  signal?: AbortSignal;
}

function request(
  o: S3MultipartOptions,
  method: string,
  query: Record<string, string>,
  body?: Uint8Array | string,
  headers: Record<string, string> = {},
  signal: AbortSignal | undefined = o.signal,
): Promise<Response> {
  const url = new URL(o.url);
  for (const [key, value] of Object.entries(query))
    url.searchParams.set(key, value);
  return o.http.send(method, url.toString(), {
    body,
    headers,
    signal,
    what: "multipart",
  });
}

export default function multipartS3(
  o: S3MultipartOptions,
): ChunkedTarget<string, string> {
  return {
    partSize: S3_PART_SIZE,
    single: o.single,

    async start() {
      const res = await request(
        o,
        "POST",
        { uploads: "" },
        undefined,
        o.headers,
      );
      const uploadId = getTag(await res.text(), "UploadId");
      if (!uploadId)
        throw new BucketError(`${o.provider} multipart start: no UploadId`, {
          provider: o.provider,
        });
      return uploadId;
    },

    async part(uploadId, n, data) {
      const res = await request(
        o,
        "PUT",
        { partNumber: String(n), uploadId },
        data,
      );
      const etag = res.headers.get("etag") ?? "";
      await res.text();
      return etag;
    },

    async finish(uploadId, etags) {
      const body =
        "<CompleteMultipartUpload>" +
        etags
          .map(
            (etag, i) =>
              `<Part><PartNumber>${i + 1}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`,
          )
          .join("") +
        "</CompleteMultipartUpload>";
      const res = await request(o, "POST", { uploadId }, body);
      // S3 can answer 200 with an <Error> body while assembling, so success
      // is determined by the body, not the status.
      const xml = await res.text();
      if (extractTags(xml, "Error").length)
        throw new BucketError(
          `${o.provider} multipart complete error: ${getTag(xml, "Message") || getTag(xml, "Code")}`,
          { provider: o.provider },
        );
    },

    async abort(uploadId) {
      // No signal: this is the cleanup for an already-aborted upload, so it
      // has to run or the parts stay open and billed.
      await request(o, "DELETE", { uploadId }, undefined, {}, undefined);
    },
  };
}
