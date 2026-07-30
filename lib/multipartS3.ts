// S3-protocol multipart upload (AWS S3 and Cloudflare R2 share it):
// CreateMultipartUpload → UploadPart × n → CompleteMultipartUpload, with
// AbortMultipartUpload on any failure so no billed orphan parts remain.

import cleanAndSignS3 from "./cleanAndSignS3.ts";
import BucketError from "./BucketError.ts";
import { escapeXml, extractTags, getTag } from "./xml.ts";
import type { ChunkedTarget } from "./chunkedWritable.ts";
import type { S3Auth, S3Request } from "./types.ts";

export const S3_PART_SIZE = 8 * 1024 * 1024;

export interface S3MultipartOptions {
  provider: string;
  path: string;
  makeUrl: (path?: string) => string;
  getAuth: () => S3Auth | Promise<S3Auth>;
  /** Content headers (type, cache-control, disposition, x-amz-meta-*) set
   * on the create call; S3 applies them to the assembled object. */
  headers: Record<string, string>;
  single: (data: Buffer) => Promise<void>;
}

async function request(
  o: S3MultipartOptions,
  method: string,
  query: Record<string, string>,
  body?: Buffer | string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const url = new URL(o.makeUrl(o.path));
  for (const [key, value] of Object.entries(query))
    url.searchParams.set(key, value);
  const req: S3Request = {
    url: url.toString(),
    method: method.toLowerCase(),
    headers: { ...headers },
    body,
  };
  await cleanAndSignS3(req, await o.getAuth());
  const res = await fetch(url.toString(), {
    method,
    headers: req.headers,
    body: body as BodyInit | undefined,
  });
  if (!res.ok)
    throw new BucketError(`${o.provider} multipart error: ${res.status}`, {
      provider: o.provider,
      status: res.status,
    });
  return res;
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
        {
          partNumber: String(n),
          uploadId,
        },
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
      await request(o, "DELETE", { uploadId });
    },
  };
}
