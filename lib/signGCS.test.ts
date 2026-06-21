// Signer test for GCS V4 presigned URLs. No Google credentials or network: we
// generate a throwaway RSA keypair, sign with presignGCS, then independently
// rebuild the GOOG4 string-to-sign per Google's spec and cryptographically
// verify the signature against the public key. If presignGCS built the wrong
// canonical request (or signed with the wrong algorithm/key), verify() fails.

import {
  generateKeyPairSync,
  createHash,
  createVerify,
  type KeyObject,
} from "node:crypto";
import { presignGCS, type GCSAuth } from "./signGCS.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const auth: GCSAuth = {
  clientEmail: "tester@my-project.iam.gserviceaccount.com",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
};

const sha256hex = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

// Rebuild the canonical request + string-to-sign exactly as Google's V4 spec
// describes, using the parameters embedded in the URL presignGCS produced.
function expectedStringToSign(
  url: URL,
  method: string,
  bucket: string,
  objectPath: string,
): string {
  const params = new URLSearchParams(url.search);
  params.delete("X-Goog-Signature");
  params.sort();
  const host = "storage.googleapis.com";
  const path = `/${bucket}/${objectPath.replace(/^\//, "")}`;
  const canonicalRequest = [
    method,
    path,
    params.toString(),
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const timestamp = params.get("X-Goog-Date")!;
  const datestamp = timestamp.slice(0, 8);
  return [
    "GOOG4-RSA-SHA256",
    timestamp,
    `${datestamp}/auto/storage/goog4_request`,
    sha256hex(canonicalRequest),
  ].join("\n");
}

function verifySignature(
  url: string,
  method: "GET" | "PUT",
  bucket: string,
  objectPath: string,
  pub: KeyObject,
): boolean {
  const u = new URL(url);
  const sigHex = u.searchParams.get("X-Goog-Signature")!;
  const stringToSign = expectedStringToSign(u, method, bucket, objectPath);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(stringToSign);
  return verifier.verify(pub, Buffer.from(sigHex, "hex"));
}

describe("presignGCS (GOOG4-RSA-SHA256 signer)", () => {
  const bucket = "my-bucket";

  it("produces a cryptographically valid GET signature", () => {
    const url = presignGCS(bucket, "photo.jpg", auth, "GET", 3600);
    expect(verifySignature(url, "GET", bucket, "photo.jpg", publicKey)).toBe(
      true,
    );
  });

  it("produces a cryptographically valid PUT (upload) signature", () => {
    const url = presignGCS(bucket, "upload.bin", auth, "PUT", 900);
    expect(verifySignature(url, "PUT", bucket, "upload.bin", publicKey)).toBe(
      true,
    );
  });

  it("signs nested and special-character keys correctly", () => {
    for (const key of ["deep/a/b.txt", "a-1*(a!.txt", "with space.txt"]) {
      const url = presignGCS(bucket, key, auth, "GET", 3600);
      expect(verifySignature(url, "GET", bucket, key, publicKey)).toBe(true);
    }
  });

  it("rejects a tampered signature (negative control)", () => {
    const url = new URL(presignGCS(bucket, "photo.jpg", auth, "GET", 3600));
    url.searchParams.set("X-Goog-Expires", "999999"); // change a signed field
    expect(
      verifySignature(url.toString(), "GET", bucket, "photo.jpg", publicKey),
    ).toBe(false);
  });

  it("emits a spec-compliant GOOG4 query string", () => {
    const u = new URL(presignGCS(bucket, "x.txt", auth, "GET", 3600));
    expect(u.host).toBe("storage.googleapis.com");
    expect(u.searchParams.get("X-Goog-Algorithm")).toBe("GOOG4-RSA-SHA256");
    expect(u.searchParams.get("X-Goog-Expires")).toBe("3600");
    expect(u.searchParams.get("X-Goog-SignedHeaders")).toBe("host");
    expect(u.searchParams.get("X-Goog-Credential")).toContain(
      "/auto/storage/goog4_request",
    );
    expect(u.searchParams.get("X-Goog-Signature")).toMatch(/^[0-9a-f]+$/);
  });
});
