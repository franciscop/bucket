// Oracle test for sha256base64 (used for the S3 DeleteObjects
// x-amz-checksum-sha256 header). Cross-checked against node:crypto.

import { createHash } from "node:crypto";
import { sha256base64 } from "./webcrypto.ts";

const ref = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("base64");

describe("sha256base64", () => {
  it("matches node:crypto on string inputs", async () => {
    for (const v of [
      "",
      "a",
      "<Delete><Object><Key>a.txt</Key></Object></Delete>",
    ]) {
      expect(await sha256base64(v)).toBe(ref(v));
    }
  });

  it("matches node:crypto on bytes, and string === equivalent bytes", async () => {
    const bytes = new Uint8Array(200).map((_, i) => (i * 31 + 7) & 0xff);
    expect(await sha256base64(bytes)).toBe(ref(bytes));
    const s = "café/münchen.txt";
    expect(await sha256base64(s)).toBe(
      await sha256base64(new TextEncoder().encode(s)),
    );
  });
});
