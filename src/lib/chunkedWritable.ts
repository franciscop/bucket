// The chunked-upload state machine shared by every remote provider. It
// accumulates incoming bytes up to one part size; if the body ends first, it
// is sent as today's single request (small files never open a session). Only
// when the body outgrows one part does it start the provider's chunked
// mechanism (multipart / large file / blocks / resumable session) and flush
// full parts as they fill, so memory stays bounded at roughly one part and
// backpressure propagates to the source.
//
// Failure rule: any error after a session is open must abort it, or S3-style
// providers keep (and bill) the orphaned parts forever. The streams spec does
// NOT call the sink's abort() when the sink's own write() rejects, so the
// machine cleans up inline on part/finish failure; the sink abort() covers
// the other direction (an erroring source or an explicit writer.abort()).

export interface ChunkedTarget<Ctx, Part> {
  /** Bytes to accumulate before escalating to a chunked upload. A function
   * for providers that only learn it at runtime (B2's auth response). */
  partSize: number | (() => Promise<number>);
  /** One-request upload, used when the whole body fits in a single part. */
  single(data: Buffer): Promise<void>;
  /** Open a chunked-upload session. Only called once a second part exists. */
  start(): Promise<Ctx>;
  /** Upload one part. `n` is 1-indexed; `isLast` marks the final part. */
  part(ctx: Ctx, n: number, data: Buffer, isLast: boolean): Promise<Part>;
  /** Assemble the uploaded parts into the final object. */
  finish(ctx: Ctx, parts: Part[]): Promise<void>;
  /** Discard the session and any uploaded parts. */
  abort(ctx: Ctx): Promise<void>;
}

class Chunker<Ctx, Part> {
  #target: ChunkedTarget<Ctx, Part>;
  #pending: Uint8Array[] = [];
  #size = 0;
  #ctx: Ctx | null = null;
  #opened = false;
  #parts: Part[] = [];
  #n = 0;
  #partSize: number | null = null;

  constructor(target: ChunkedTarget<Ctx, Part>) {
    this.#target = target;
  }

  async #resolvePartSize(): Promise<number> {
    if (this.#partSize === null) {
      const ps = this.#target.partSize;
      this.#partSize = typeof ps === "function" ? await ps() : ps;
    }
    return this.#partSize;
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.#pending.push(chunk);
    this.#size += chunk.length;
    const partSize = await this.#resolvePartSize();
    if (this.#size <= partSize) return;
    try {
      if (!this.#opened) {
        this.#ctx = await this.#target.start();
        this.#opened = true;
      }
      while (this.#size > partSize) {
        const all = Buffer.concat(this.#pending);
        const rest = all.subarray(partSize);
        this.#pending = [rest];
        this.#size = rest.length;
        const head = Buffer.from(all.subarray(0, partSize));
        this.#parts.push(
          await this.#target.part(this.#ctx!, ++this.#n, head, false),
        );
      }
    } catch (err) {
      await this.#cleanup();
      throw err;
    }
  }

  async close(): Promise<void> {
    const data = Buffer.concat(this.#pending);
    this.#pending = [];
    this.#size = 0;
    if (!this.#opened) return this.#target.single(data);
    try {
      this.#parts.push(
        await this.#target.part(this.#ctx!, ++this.#n, data, true),
      );
      await this.#target.finish(this.#ctx!, this.#parts);
    } catch (err) {
      await this.#cleanup();
      throw err;
    }
  }

  async abort(): Promise<void> {
    // An aborted body uploads nothing: no single(), and any open session is
    // cancelled so no partial object (or billed orphaned parts) remains.
    this.#pending = [];
    this.#size = 0;
    await this.#cleanup();
  }

  async #cleanup(): Promise<void> {
    if (!this.#opened) return;
    this.#opened = false;
    const ctx = this.#ctx!;
    this.#ctx = null;
    try {
      await this.#target.abort(ctx);
    } catch {
      // Best-effort: surface the original failure, not the cleanup's.
    }
  }
}

export default function chunkedWritable<Ctx, Part>(
  target: ChunkedTarget<Ctx, Part>,
): WritableStream<Uint8Array> {
  const chunker = new Chunker(target);
  return new WritableStream<Uint8Array>({
    write: (chunk) => chunker.write(chunk),
    close: () => chunker.close(),
    abort: () => chunker.abort(),
  });
}

/** Run the same machine over an in-memory body of known size. */
export async function writeChunked<Ctx, Part>(
  target: ChunkedTarget<Ctx, Part>,
  data: Buffer,
): Promise<void> {
  const chunker = new Chunker(target);
  await chunker.write(data);
  await chunker.close();
}
