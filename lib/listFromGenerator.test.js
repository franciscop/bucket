import { WritableStream } from "node:stream/web";

import listFromGenerator from "./listFromGenerator";

const list = listFromGenerator(async function* (opts = {}) {
  const { prefix, limit = 10 } = opts;
  let i = 0;
  while (true) {
    if (i >= limit) return;
    await new Promise((done) => setTimeout(done, 100));
    yield { i };
    i++;
  }
});

// await list({ limit: 3 }).pipeTo(writable);

// for await (const item of list({ limit: 3 })) {
//   console.log(item);
// }

// console.log(await list({ limit: 3 }));

describe("listFromGenerator", () => {
  it("can await for a promise", async () => {
    expect(await list({ limit: 3 })).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
  });

  it("can await for a pipeTo()", async () => {
    const files = [];
    const writable = new WritableStream({
      write(file) {
        files.push(file);
      },
    });
    await list({ limit: 3 }).pipeTo(writable);
    expect(files).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
  });

  it("can await for a loop for async", async () => {
    const files = [];
    for await (const item of list({ limit: 3 })) {
      files.push(item);
    }
    expect(files).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
  });
});
