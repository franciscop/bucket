// This test only covers the things specific for this bucket;
// the shared API conformance suite is under test/index.test.ts at the root,
// which Memory runs against in full with no skips.

import { Readable } from "node:stream";

import Memory from "./index.ts";

const codeOf = async (fn: () => unknown): Promise<string | undefined> => {
  try {
    await fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
};

describe("Memory write options round-trip", () => {
  it("keeps every option info() can report", async () => {
    const bucket = Memory();
    const file = await bucket.file("report.txt").write("a,b", {
      type: "text/csv",
      cacheControl: "max-age=31536000, public",
      disposition: 'attachment; filename="report.csv"',
      metadata: { Owner: "ana", Project: "x" },
    });

    const info = (await file.info())!;
    expect(info.type).toBe("text/csv");
    expect(info.cacheControl).toBe("max-age=31536000, public");
    expect(info.disposition).toBe('attachment; filename="report.csv"');
    // Lowercased like the remotes, which send metadata as headers
    expect(info.metadata).toEqual({ owner: "ana", project: "x" });
  });

  it("does not silently ignore the type, unlike the filesystem", async () => {
    const bucket = Memory();
    for (const type of ["text/csv", "csv", ".csv"]) {
      const file = await bucket.file("a.txt").write("a,b", { type });
      expect((await file.info())!.type).toBe("text/csv");
    }
  });

  it("falls back to the extension when no type is given", async () => {
    const bucket = Memory();
    const file = await bucket.file("page.html").write("<p>hi</p>");
    expect((await file.info())!.type).toBe("text/html");
  });

  it("reports no metadata as an empty object, not undefined", async () => {
    const bucket = Memory();
    const file = await bucket.file("a.txt").write("x");
    const info = (await file.info())!;
    expect(info.metadata).toEqual({});
    expect(info.cacheControl).toBeUndefined();
    expect(info.version).toBeNull();
  });
});

describe("Memory instances are isolated", () => {
  it("two buckets never see each other's files", async () => {
    const a = Memory("a");
    const b = Memory("b");

    await a.file("only-in-a.txt").write("x");
    expect(await a.count()).toBe(1);
    expect(await b.count()).toBe(0);
    expect(await b.file("only-in-a.txt").exists()).toBe(false);
  });

  it("a folder shares the parent's store", async () => {
    const bucket = Memory();
    await bucket.folder("sub").file("a.txt").write("x");
    expect(await bucket.file("sub/a.txt").text()).toBe("x");
    expect(await bucket.count()).toBe(1);
  });

  it("copies the bytes rather than sharing them", async () => {
    const bucket = Memory();
    await bucket.file("src.txt").write("original");
    await bucket.file("src.txt").copyTo("dst.txt");
    await bucket.file("src.txt").write("changed");

    expect(await bucket.file("dst.txt").text()).toBe("original");
  });
});

describe("Memory streams", () => {
  it("reads through both stream flavours", async () => {
    const bucket = Memory();
    await bucket.file("a.txt").write("streamed");

    const web = bucket.file("a.txt").stream();
    expect(await new Response(web).text()).toBe("streamed");

    const chunks: Buffer[] = [];
    for await (const chunk of bucket.file("a.txt").nodeReadable()) {
      chunks.push(Buffer.from(chunk as Buffer));
    }
    expect(Buffer.concat(chunks).toString()).toBe("streamed");
  });

  it("writes through both stream flavours, keeping the options", async () => {
    const bucket = Memory();

    const writer = bucket
      .file("web.txt")
      .writable({ type: "text/csv" })
      .getWriter();
    await writer.write(new TextEncoder().encode("from web"));
    await writer.close();
    expect(await bucket.file("web.txt").text()).toBe("from web");
    expect((await bucket.file("web.txt").info())!.type).toBe("text/csv");

    const node = bucket.file("node.txt").nodeWritable();
    await new Promise<void>((resolve, reject) => {
      Readable.from(["from ", "node"])
        .pipe(node)
        .on("finish", resolve)
        .on("error", reject);
    });
    expect(await bucket.file("node.txt").text()).toBe("from node");
  });

  it("commits a streamed write only on close", async () => {
    const bucket = Memory();
    const writer = bucket.file("partial.txt").writable().getWriter();
    await writer.write(new TextEncoder().encode("half"));

    expect(await bucket.file("partial.txt").exists()).toBe(false);
    await writer.close();
    expect(await bucket.file("partial.txt").text()).toBe("half");
  });

  it("leaves nothing behind when a streamed write is aborted", async () => {
    const bucket = Memory();
    const writer = bucket.file("aborted.txt").writable().getWriter();
    await writer.write(new TextEncoder().encode("half"));
    await writer.abort(new Error("nope"));

    expect(await bucket.file("aborted.txt").exists()).toBe(false);
  });
});

describe("Memory URLs", () => {
  it("returns null for publicUrl() when unset", async () => {
    const bucket = Memory();
    expect(await bucket.file("a.txt").publicUrl()).toBeNull();
  });

  it("uses a configured publicUrl, encoding the path", async () => {
    const bucket = Memory("m", { publicUrl: "https://cdn.example.com/" });
    expect(await bucket.file("a b&c.txt").publicUrl()).toBe(
      "https://cdn.example.com/a%20b%26c.txt",
    );
    expect(await bucket.folder("sub").file("a.txt").publicUrl()).toBe(
      "https://cdn.example.com/sub/a.txt",
    );
  });

  it("returns null for signedUrl() and uploadUrl(): nothing to sign", async () => {
    const bucket = Memory();
    await bucket.file("a.txt").write("x");
    expect(await bucket.file("a.txt").signedUrl({ expires: "1h" })).toBeNull();
    expect(await bucket.file("a.txt").uploadUrl({ expires: "1h" })).toBeNull();
  });
});

describe("Memory errors match the other providers", () => {
  it("throws NOT_FOUND on every read of a missing file", async () => {
    const bucket = Memory();
    const file = bucket.file("missing.txt");
    for (const method of [
      "text",
      "json",
      "arrayBuffer",
      "blob",
      "bytes",
    ] as const) {
      expect(await codeOf(() => (file[method] as Function)())).toBe(
        "NOT_FOUND",
      );
    }
    // info()/exists() never throw for a missing file
    expect(await file.info()).toBeNull();
    expect(await file.exists()).toBe(false);
  });

  it("throws INVALID_PATH on an escape", async () => {
    const bucket = Memory();
    expect(await codeOf(() => bucket.file("../outside.txt"))).toBe(
      "INVALID_PATH",
    );
    expect(await codeOf(() => bucket.folder("a").folder("../.."))).toBe(
      "INVALID_PATH",
    );
  });

  it("throws INVALID_FILTER like every other bucket", async () => {
    const bucket = Memory();
    expect(await codeOf(() => bucket.remove(undefined as never))).toBe(
      "INVALID_FILTER",
    );
    expect(await codeOf(() => bucket.list("x" as never))).toBe(
      "INVALID_FILTER",
    );
  });

  it("throws INVALID_CONFIG without a name", async () => {
    expect(await codeOf(() => Memory(""))).toBe("INVALID_CONFIG");
  });

  it("aborts like the other providers", async () => {
    const bucket = Memory();
    await bucket.file("a.txt").write("x");
    const signal = AbortSignal.abort();

    for (const run of [
      () => bucket.file("a.txt").text({ signal }),
      () => bucket.file("a.txt").info({ signal }),
      () => bucket.file("a.txt").remove({ signal }),
      () => bucket.file("b.txt").write("x", { signal }),
      () => bucket.list(undefined, { signal }),
      () => bucket.count(undefined, { signal }),
      () => bucket.remove(/./, { signal }),
      () => bucket.scan(undefined, { signal }),
    ]) {
      expect(await codeOf(run)).toBe("ABORTED");
    }
    // The aborted remove() deleted nothing
    expect(await bucket.count()).toBe(1);
  });
});
