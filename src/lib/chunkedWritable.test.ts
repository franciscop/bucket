// The chunked-upload core used by every remote provider's write path. It
// accumulates up to one part size and only opens a multipart session when the
// body outgrows it, so small uploads stay a single request. Tested against a
// mock target; the provider-specific requests are covered by the emulators.

import chunkedWritable, {
  writeChunked,
  type ChunkedTarget,
} from "./chunkedWritable.ts";

const PART = 100;

function makeTarget(partSize: number | (() => Promise<number>) = PART) {
  const events: string[] = [];
  const buffers: Buffer[] = [];
  let single: Buffer | null = null;
  let inFlight = 0;
  let maxInFlight = 0;
  let failPart: number | null = null;
  let failFinish = false;
  let partSizeCalls = 0;

  const resolvedPartSize =
    typeof partSize === "function"
      ? async () => {
          partSizeCalls++;
          return partSize();
        }
      : partSize;

  const target: ChunkedTarget<string, string> = {
    partSize: resolvedPartSize,
    async single(data: Buffer) {
      single = data;
      events.push(`single:${data.length}`);
    },
    async start() {
      events.push("start");
      return "CTX";
    },
    async part(ctx, n, data, isLast) {
      if (ctx !== "CTX") throw new Error("wrong ctx");
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      if (n === failPart) throw new Error("part failed");
      buffers.push(data);
      events.push(`part:${n}:${data.length}${isLast ? ":last" : ""}`);
      return `etag-${n}`;
    },
    async finish(_ctx, parts) {
      if (failFinish) throw new Error("finish failed");
      events.push(`finish:${parts.join(",")}`);
    },
    async abort() {
      events.push("abort");
    },
  };

  return {
    target,
    events,
    buffers,
    getSingle: () => single,
    maxInFlight: () => maxInFlight,
    setFailPart: (n: number) => (failPart = n),
    setFailFinish: () => (failFinish = true),
    getPartSizeCalls: () => partSizeCalls,
  };
}

// A recognizable byte pattern so reassembly can be verified byte-for-byte
const pattern = (size: number, seed = 0): Uint8Array => {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (seed + i) % 256;
  return data;
};

async function pump(
  w: WritableStream<Uint8Array>,
  chunks: Uint8Array[],
): Promise<void> {
  const writer = w.getWriter();
  for (const chunk of chunks) await writer.write(chunk);
  await writer.close();
}

describe("chunkedWritable: single-shot path", () => {
  it("stays single below the part size and never starts a session", async () => {
    const t = makeTarget();
    await pump(chunkedWritable(t.target), [pattern(30), pattern(20, 30)]);
    expect(t.events).toEqual(["single:50"]);
    expect(Buffer.compare(t.getSingle()!, Buffer.from(pattern(50)))).toBe(0);
  });

  it("a body of exactly one part stays single", async () => {
    const t = makeTarget();
    await pump(chunkedWritable(t.target), [pattern(PART)]);
    expect(t.events).toEqual([`single:${PART}`]);
  });

  it("an empty body is a single empty upload", async () => {
    const t = makeTarget();
    await pump(chunkedWritable(t.target), []);
    expect(t.events).toEqual(["single:0"]);
  });
});

describe("chunkedWritable: escalation", () => {
  it("escalates past one part and reassembles byte-for-byte", async () => {
    const t = makeTarget();
    const input = pattern(250);
    await pump(chunkedWritable(t.target), [
      input.slice(0, 40),
      input.slice(40, 80),
      input.slice(80, 160),
      input.slice(160),
    ]);
    expect(t.events).toEqual([
      "start",
      "part:1:100",
      "part:2:100",
      "part:3:50:last",
      "finish:etag-1,etag-2,etag-3",
    ]);
    const merged = Buffer.concat(t.buffers);
    expect(Buffer.compare(merged, Buffer.from(input))).toBe(0);
  });

  it("slices a single oversized chunk into exact parts", async () => {
    const t = makeTarget();
    await pump(chunkedWritable(t.target), [pattern(350)]);
    expect(t.events).toEqual([
      "start",
      "part:1:100",
      "part:2:100",
      "part:3:100",
      "part:4:50:last",
      "finish:etag-1,etag-2,etag-3,etag-4",
    ]);
  });

  it("an exact multiple of the part size flags the last full part", async () => {
    const t = makeTarget();
    await pump(chunkedWritable(t.target), [pattern(200)]);
    expect(t.events).toEqual([
      "start",
      "part:1:100",
      "part:2:100:last",
      "finish:etag-1,etag-2",
    ]);
  });

  it("uploads parts sequentially (constant memory, backpressure)", async () => {
    const t = makeTarget();
    await pump(chunkedWritable(t.target), [pattern(550)]);
    expect(t.maxInFlight()).toBe(1);
  });

  it("resolves an async partSize exactly once", async () => {
    const t = makeTarget(async () => PART);
    await pump(chunkedWritable(t.target), [pattern(250)]);
    expect(t.getPartSizeCalls()).toBe(1);
    expect(t.events[0]).toBe("start");
  });
});

describe("chunkedWritable: failure handling", () => {
  it("a failing part aborts the session and never finishes", async () => {
    const t = makeTarget();
    t.setFailPart(2);
    const writer = chunkedWritable(t.target).getWriter();
    let threw = false;
    try {
      await writer.write(pattern(150));
      await writer.write(pattern(150));
      await writer.close();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(t.events).toEqual(["start", "part:1:100", "abort"]);
  });

  it("a failing finish aborts the session", async () => {
    const t = makeTarget();
    t.setFailFinish();
    const writer = chunkedWritable(t.target).getWriter();
    let threw = false;
    try {
      await writer.write(pattern(250));
      await writer.close();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(t.events).toContain("abort");
    expect(t.events.filter((e) => e.startsWith("finish"))).toEqual([]);
  });

  it("aborting before escalation uploads nothing at all", async () => {
    const t = makeTarget();
    const writer = chunkedWritable(t.target).getWriter();
    await writer.write(pattern(50));
    await writer.abort(new Error("stop"));
    expect(t.events).toEqual([]); // no single(), no start(), no abort()
  });

  it("aborting after escalation cancels the session", async () => {
    const t = makeTarget();
    const writer = chunkedWritable(t.target).getWriter();
    await writer.write(pattern(150));
    await writer.abort(new Error("stop"));
    expect(t.events).toEqual(["start", "part:1:100", "abort"]);
  });

  it("an erroring source piped in cleans up and rejects", async () => {
    const t = makeTarget();
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(pattern(150));
      },
      pull(c) {
        c.error(new Error("boom"));
      },
    });
    let threw = false;
    try {
      await source.pipeTo(chunkedWritable(t.target));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(t.events).toEqual(["start", "part:1:100", "abort"]);
  });
});

describe("writeChunked (buffered bodies)", () => {
  it("small buffers go through single()", async () => {
    const t = makeTarget();
    await writeChunked(t.target, Buffer.from(pattern(80)));
    expect(t.events).toEqual(["single:80"]);
  });

  it("large buffers chunk and reassemble byte-for-byte", async () => {
    const t = makeTarget();
    const input = Buffer.from(pattern(250));
    await writeChunked(t.target, input);
    expect(t.events).toEqual([
      "start",
      "part:1:100",
      "part:2:100",
      "part:3:50:last",
      "finish:etag-1,etag-2,etag-3",
    ]);
    expect(Buffer.compare(Buffer.concat(t.buffers), input)).toBe(0);
  });

  it("a failing part aborts and propagates", async () => {
    const t = makeTarget();
    t.setFailPart(1);
    let threw = false;
    try {
      await writeChunked(t.target, Buffer.from(pattern(250)));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(t.events).toEqual(["start", "abort"]);
  });
});
