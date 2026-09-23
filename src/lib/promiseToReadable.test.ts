import promiseToReadable from "./promiseToReadable.ts";

// A source that counts how many chunks have been pulled from it.
function counted(total = 100) {
  const state = { pulled: 0, cancelled: false };
  const source = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (state.pulled++ < total) c.enqueue(new Uint8Array(1024));
        else c.close();
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 1 },
  );
  return { source, state };
}

const tick = () => new Promise((r) => setTimeout(r, 50));

describe("promiseToReadable", () => {
  it("reads ahead only as far as the consumer asks", async () => {
    const { source, state } = counted();
    promiseToReadable(async () => source);
    await tick();
    expect(state.pulled).toBeLessThan(5);
  });

  it("passes every chunk through in order", async () => {
    const { source } = counted(10);
    let bytes = 0;
    for await (const chunk of promiseToReadable(async () => source))
      bytes += chunk.byteLength;
    expect(bytes).toBe(10 * 1024);
  });

  it("cancels the source when the consumer cancels", async () => {
    const { source, state } = counted();
    const stream = promiseToReadable(async () => source);
    await stream.cancel();
    expect(state.cancelled).toBe(true);
  });

  it("surfaces a failure to open the source as a read error", async () => {
    const stream = promiseToReadable(async () => {
      throw new Error("not found");
    });
    await expect(stream.getReader().read()).rejects.toThrow("not found");
  });
});
