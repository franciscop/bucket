// Executable documentation for the readme's "Combining with other APIs"
// section. Uses the FileSystem provider so it runs everywhere, no credentials.
// A File is a lazy handle (not a Blob): interop goes through .stream() / .blob().

import FileSystem from "../fs/index.ts";
import { mkdir, rm } from "node:fs/promises";

const DIR = "./fs/test-interop/";
const bucket = FileSystem(DIR);
const tmp = (ext = "txt"): string =>
  `io${Math.floor(Math.random() * 1e6)}.${ext}`;

beforeAll(() => mkdir(DIR, { recursive: true }));
afterAll(() => rm(DIR, { recursive: true, force: true }));

describe("Interop: Web APIs", () => {
  it("serves a file as a streaming Response", async () => {
    const file = bucket.file(tmp());
    await file.write("served over http");
    const res = new Response(file.stream() as ReadableStream);
    expect(await res.text()).toBe("served over http");
  });

  it("attaches a file to FormData with its name and type", async () => {
    const file = bucket.file(tmp("json"));
    await file.write(JSON.stringify({ ok: true }));
    const form = new FormData();
    form.append("upload", await file.blob(), file.name);
    const part = form.get("upload") as File;
    expect(part.name).toBe(file.name);
    // type survives the round-trip (some runtimes append "; charset=utf-8")
    expect(part.type).toContain("application/json");
    expect(JSON.parse(await part.text())).toEqual({ ok: true });
  });

  it("streams a file as an outbound request body", async () => {
    const file = bucket.file(tmp());
    await file.write("request body");
    const init = {
      method: "PUT",
      body: file.stream(),
      duplex: "half",
    } as RequestInit;
    const req = new Request("http://example.com", init);
    expect(await req.text()).toBe("request body");
  });

  it("stores an incoming response body (buffered)", async () => {
    const incoming = new Response(new Uint8Array([9, 8, 7]));
    const file = bucket.file(tmp("bin"));
    await file.write(await incoming.blob());
    expect(await file.bytes()).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("stores an incoming response body (streamed, no buffering)", async () => {
    const incoming = new Response("streamed in");
    const file = bucket.file(tmp());
    await incoming.body!.pipeTo(file.writable() as WritableStream);
    expect(await file.text()).toBe("streamed in");
  });
});

describe("Interop: combining buckets", () => {
  it("copies a file into another bucket via write(file)", async () => {
    const other = FileSystem(DIR + "other/");
    const src = bucket.file(tmp());
    await src.write("cross-bucket");
    const dst = other.file(tmp());
    await dst.write(src); // write() accepts a File from any provider
    expect(await dst.text()).toBe("cross-bucket");
  });

  it("pipes one file into another (web streams)", async () => {
    const a = bucket.file(tmp());
    await a.write("piped between files");
    const b = bucket.file(tmp());
    await (a.stream() as ReadableStream).pipeTo(b.writable() as WritableStream);
    expect(await b.text()).toBe("piped between files");
  });
});

describe("Interop: Bun file APIs", () => {
  const hasBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  const bunIt = hasBun ? it : it.skip;

  bunIt("writes a Bun.file() (a Blob) into a bucket", async () => {
    const file = bucket.file(tmp("jpg"));
    await file.write(Bun.file("./test/bucket/nero.jpg"));
    expect((await file.info()).size).toBe(175888);
  });

  bunIt("writes a bucket file's blob to disk with Bun.write", async () => {
    const file = bucket.file(tmp());
    await file.write("to local disk");
    const out = `${DIR}${tmp()}`;
    await Bun.write(out, await file.blob());
    expect(await Bun.file(out).text()).toBe("to local disk");
  });

  bunIt("resizes an image with Bun.Image and stores the result", async () => {
    // Bun.Image is native but not in @types/bun yet, so reach for it via a cast.
    const BunImage = (Bun as unknown as { Image: new (b: Uint8Array) => any })
      .Image;

    // read an image from the bucket, resize + re-encode, write it back
    const original = bucket.file(tmp("jpg"));
    await original.write(Bun.file("./test/bucket/nero.jpg"));
    const thumbBytes: Buffer = await new BunImage(await original.bytes())
      .resize(200, 200)
      .webp()
      .toBuffer();

    const thumb = bucket.file(tmp("webp"));
    await thumb.write(thumbBytes, { type: "image/webp" });

    const meta = await new BunImage(await thumb.bytes()).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(200);
    expect(meta.format).toBe("webp");
    expect((await thumb.info()).type).toBe("image/webp");
  });
});
