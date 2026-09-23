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
// describes. Google signs the path and host exactly as the request carries them.
function expectedStringToSign(url: URL, method: string): string {
  const params = new URLSearchParams(url.search);
  params.delete("X-Goog-Signature");
  params.sort();
  const canonicalRequest = [
    method,
    url.pathname,
    params.toString(),
    `host:${url.host}\n`,
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

function verifySignature(url: string, method: string, pub: KeyObject) {
  const u = new URL(url);
  const sigHex = u.searchParams.get("X-Goog-Signature")!;
  const verifier = createVerify("RSA-SHA256");
  verifier.update(expectedStringToSign(u, method));
  return verifier.verify(pub, Buffer.from(sigHex, "hex"));
}

const sign = (
  path: string,
  method: "GET" | "PUT" = "GET",
  expires = 3600,
  url = "https://storage.googleapis.com",
) => presignGCS({ url, bucket: "my-bucket", path, auth, method, expires });

describe("presignGCS (GOOG4-RSA-SHA256 signer)", () => {
  it("produces a cryptographically valid GET signature", async () => {
    const url = await sign("photo.jpg");
    expect(verifySignature(url, "GET", publicKey)).toBe(true);
  });

  it("produces a cryptographically valid PUT (upload) signature", async () => {
    const url = await sign("upload.bin", "PUT", 900);
    expect(verifySignature(url, "PUT", publicKey)).toBe(true);
  });

  it("signs nested and special-character keys correctly", async () => {
    for (const key of ["deep/a/b.txt", "a-1*(a!.txt", "with space.txt"]) {
      expect(verifySignature(await sign(key), "GET", publicKey)).toBe(true);
    }
  });

  it("encodes the key in the path it signs", async () => {
    const u = new URL(await sign("dir/a?#+% b é.txt"));
    expect(u.pathname).toBe("/my-bucket/dir/a%3F%23%2B%25%20b%20%C3%A9.txt");
    expect(verifySignature(u.toString(), "GET", publicKey)).toBe(true);
  });

  it("signs for a custom endpoint, like an emulator", async () => {
    const url = await sign("x.txt", "GET", 60, "http://127.0.0.1:4443");
    expect(url.startsWith("http://127.0.0.1:4443/my-bucket/x.txt?")).toBe(true);
    expect(verifySignature(url, "GET", publicKey)).toBe(true);
  });

  it("rejects a tampered signature (negative control)", async () => {
    const url = new URL(await sign("photo.jpg"));
    url.searchParams.set("X-Goog-Expires", "999999"); // change a signed field
    expect(verifySignature(url.toString(), "GET", publicKey)).toBe(false);
  });

  it("emits a spec-compliant GOOG4 query string", async () => {
    const u = new URL(await sign("x.txt"));
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
