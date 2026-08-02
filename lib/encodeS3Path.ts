// AWS/S3 canonicalization percent-encodes characters that the WHATWG URL
// parser handles differently in a path: the RFC-3986 sub-delimiters ! ' ( ) *
// & plus < and >. The request must be SENT with these encoded too, so the
// sent URL matches the signed canonical form. AWS S3 reconciles a raw path
// with the signed (encoded) one; Cloudflare R2 does not (404 for a key whose
// sent path differs from the key it stored), and MinIO rejects the signature
// outright for a raw "&", "<" or ">". Applying this when building the URL
// keeps write, read, and HEAD consistent across providers. Everything else
// (spaces, unicode) is handled identically by the URL parser on both the send
// and sign sides, so only these eight characters need explicit handling.
// Idempotent: already-encoded input is left unchanged.
export default function encodeS3Path(path: string): string {
  return path.replace(
    /[!'()*&<>]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}
