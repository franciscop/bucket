import { ReadableStream } from "stream/web";

// Convert a generator into a ReadablePromise, so that it can be called with
// both "await", ".pipeTo()", or "for await"
export default function listFromGenerator(generator) {
  return (opts) => {
    const stream = new ReadableStream({
      async start(controller) {
        for await (const value of generator(opts)) {
          controller.enqueue(value);
        }
        controller.close();
      },
    });
    let prom;
    stream.then = (fulfilled, rejected) => {
      if (prom) return prom;
      prom = (async () => {
        try {
          const values = [];
          for await (const value of stream) {
            values.push(value);
          }
          fulfilled(values);
        } catch (error) {
          rejected(error);
        }
      })();
      return prom;
    };
    return stream;
  };
}
