// Accepts a promise, or an async function, and returns
// the readable that is returned by the promise
export default function promiseToReadable(work) {
  if (typeof work === "function") work = work();
  return new ReadableStream({
    async start(controller) {
      for await (let chunk of await work) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}
