import { WritableStream } from "node:stream/web";

import listFromGenerator from "./listFromGenerator.ts";

interface Item {
  i: number;
}

interface ListOpts {
  prefix?: string;
  limit?: number;
}

const list = listFromGenerator<Item, ListOpts>(async function* (opts = {}) {
  const { limit = 10 } = opts;
  let i = 0;
  while (true) {
    if (i >= limit) return;
    await new Promise<void>((done) => setTimeout(done, 100));
    yield { i };
    i++;
  }
});

describe("listFromGenerator", () => {
  it("can await for a promise", async () => {
    expect(await list({ limit: 3 })).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
  });

  it("can await for a pipeTo()", async () => {
    const files: Item[] = [];
    const writable = new WritableStream<Item>({
      write(file: Item) {
        files.push(file);
      },
    });
    await list({ limit: 3 }).pipeTo(writable);
    expect(files).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
  });

  it("can await for a loop for async", async () => {
    const files: Item[] = [];
    for await (const item of list({ limit: 3 })) {
      files.push(item);
    }
    expect(files).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
  });
});
