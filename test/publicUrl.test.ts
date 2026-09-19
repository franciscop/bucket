// `publicUrl` is a declaration of where the bucket is served from, so these
// tests never fetch anything: they assert the string the library builds. The
// providers are constructed with fake credentials and never touched over the
// network, which is why every provider can be covered here rather than only
// the ones with a running emulator.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import FileSystem from "../src/fs/index.ts";
import S3 from "../src/s3/index.ts";
import R2 from "../src/r2/index.ts";
import GCS from "../src/gcs/index.ts";
import Azure from "../src/azure/index.ts";
import { encodePublicPath, publicUrlFrom } from "../src/lib/publicUrl.ts";

const CDN = "https://cdn.example.com";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "bucket-public-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// Every remote provider, built without touching the network. B2 is absent
// because its canonical URL needs an authenticated round-trip; its configured
// branch is covered in b2/index.test.ts.
const withPublic = (publicUrl: string) => ({
  S3: S3("my-bucket", { id: "x", secret: "y", publicUrl }),
  R2: R2("my-bucket", {
    id: "x",
    secret: "y",
    account: "acc",
    url: "",
    publicUrl,
  }),
  GCS: GCS("my-bucket", { anonymous: true, publicUrl }),
  Azure: Azure("my-container", { account: "acct", key: "k", publicUrl }),
  FS: FileSystem(tempDir(), { publicUrl }),
});

describe("publicUrl is used when configured", () => {
  it("returns the configured origin on every provider", async () => {
    for (const [name, bucket] of Object.entries(withPublic(CDN))) {
      const url = await bucket.file("photo.jpg").publicUrl();
      expect(`${name}: ${url}`).toBe(`${name}: ${CDN}/photo.jpg`);
    }
  });

  it("includes the folder prefix in the path", async () => {
    for (const [name, bucket] of Object.entries(withPublic(CDN))) {
      const url = await bucket.folder("public").file("a.png").publicUrl();
      expect(`${name}: ${url}`).toBe(`${name}: ${CDN}/public/a.png`);
    }
  });

  it("treats a trailing slash and a subpath consistently", async () => {
    const plain = withPublic(`${CDN}/assets`);
    const slash = withPublic(`${CDN}/assets/`);
    for (const name of Object.keys(plain) as (keyof typeof plain)[]) {
      const a = await plain[name].file("photo.jpg").publicUrl();
      const b = await slash[name].file("photo.jpg").publicUrl();
      expect(`${name}: ${a}`).toBe(`${name}: ${CDN}/assets/photo.jpg`);
      expect(`${name}: ${b}`).toBe(`${name}: ${a}`);
    }
  });
});

describe("publicUrl falls back to the provider's canonical URL", () => {
  it("uses each provider's own URL when unset", async () => {
    expect(
      await S3("my-bucket", { id: "x", secret: "y" }).file("a.txt").publicUrl(),
    ).toBe("https://my-bucket.s3.us-east-1.amazonaws.com/a.txt");

    expect(
      await GCS("my-bucket", { anonymous: true, publicUrl: "" })
        .file("a.txt")
        .publicUrl(),
    ).toBe("https://storage.googleapis.com/my-bucket/a.txt");

    expect(
      await Azure("my-container", { account: "acct", key: "k", publicUrl: "" })
        .file("a.txt")
        .publicUrl(),
    ).toBe("https://acct.blob.core.windows.net/my-container/a.txt");
  });

  it("returns null where there is no canonical public URL", async () => {
    // R2's storage endpoint and a local directory are never publicly readable.
    const r2 = R2("my-bucket", {
      id: "x",
      secret: "y",
      account: "acc",
      url: "",
      publicUrl: "",
    });
    expect(await r2.file("a.txt").publicUrl()).toBeNull();
    expect(await FileSystem(tempDir()).file("a.txt").publicUrl()).toBeNull();
  });

  it("FS returns a URL once configured", async () => {
    const bucket = FileSystem(tempDir(), {
      publicUrl: "http://localhost:3000/static",
    });
    expect(await bucket.file("a.txt").publicUrl()).toBe(
      "http://localhost:3000/static/a.txt",
    );
  });
});

describe("publicUrl encodes the path", () => {
  // "#" and "?" would truncate the URL and "+" would decode as a space; none
  // of them are handled by the signing encoders, which rely on the URL parser.
  const awkward = [
    ["a b.txt", "a%20b.txt"],
    ["a&b.txt", "a%26b.txt"],
    ["a+b.txt", "a%2Bb.txt"],
    ["a#b.txt", "a%23b.txt"],
    ["a?b.txt", "a%3Fb.txt"],
    ["ñ-ü.txt", "%C3%B1-%C3%BC.txt"],
    ["100%.txt", "100%25.txt"],
  ] as const;

  it("produces a parseable URL for every awkward key", async () => {
    for (const [key, encoded] of awkward) {
      for (const [name, bucket] of Object.entries(withPublic(CDN))) {
        const url = (await bucket.file(key).publicUrl())!;
        expect(`${name} ${key}: ${url}`).toBe(
          `${name} ${key}: ${CDN}/${encoded}`,
        );
        // Round-trips: the parsed path decodes back to the original key.
        expect(decodeURIComponent(new URL(url).pathname)).toBe(`/${key}`);
      }
    }
  });

  it("encodes the canonical URLs too, not just the configured one", async () => {
    const bucket = S3("my-bucket", { id: "x", secret: "y" });
    for (const [key, encoded] of awkward) {
      const url = await bucket.file(key).publicUrl();
      expect(url).toBe(
        `https://my-bucket.s3.us-east-1.amazonaws.com/${encoded}`,
      );
    }
  });

  it("keeps the / separators unencoded", () => {
    expect(encodePublicPath("a/b c/d.txt")).toBe("a/b%20c/d.txt");
    expect(publicUrlFrom(`${CDN}///`, "a/b.txt")).toBe(`${CDN}/a/b.txt`);
  });
});

describe("publicUrl falls back to an env var", () => {
  // Every provider reads its env vars once, at module load, so setting
  // process.env from inside a test is too late. Each case runs in its own
  // process with only that variable set.
  const vars: Record<string, string> = {
    AWS_PUBLIC_URL: `S3("my-bucket", { id: "x", secret: "y" })`,
    R2_PUBLIC_URL: `R2("my-bucket", { id: "x", secret: "y", account: "a", url: "" })`,
    GCS_PUBLIC_URL: `GCS("my-bucket", { anonymous: true })`,
    AZURE_PUBLIC_URL: `Azure("my-container", { account: "a", key: "k" })`,
    FS_PUBLIC_URL: `FileSystem(".")`,
  };
  const dir = {
    S3: "s3",
    R2: "r2",
    GCS: "gcs",
    Azure: "azure",
    FileSystem: "fs",
  };

  for (const [name, expr] of Object.entries(vars)) {
    it(`reads ${name}`, async () => {
      const provider = expr.split("(")[0] as keyof typeof dir;
      const script =
        `import P from "./src/${dir[provider]}/index.ts";` +
        `const ${provider} = P;` +
        `console.log(await ${expr}.file("a.txt").publicUrl());`;
      // --env-file=/dev/null stops Bun loading the repo's own .env.
      const proc = Bun.spawn(["bun", "--env-file=/dev/null", "-e", script], {
        cwd: import.meta.dir + "/..",
        env: { PATH: process.env.PATH ?? "", [name]: `${CDN}/from-env` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = (await new Response(proc.stdout).text()).trim();
      const err = (await new Response(proc.stderr).text()).trim();
      expect(`${name}: ${out || err}`).toBe(`${name}: ${CDN}/from-env/a.txt`);
    });
  }
});
