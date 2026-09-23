// A stream over a body that is only known once `work` resolves. It pulls one
// chunk per consumer read, so a slow reader never makes it buffer the body.
export default function promiseToReadable(
  work: (() => Promise<ReadableStream>) | Promise<ReadableStream>,
): ReadableStream {
  const body = typeof work === "function" ? work() : work;
  let reader: ReadableStreamDefaultReader | undefined;
  return new ReadableStream({
    async pull(controller) {
      reader ??= (await body).getReader();
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      reader ??= (await body).getReader();
      await reader.cancel(reason);
    },
  });
}
