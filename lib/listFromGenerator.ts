import { ReadableStream } from "stream/web";

type AsyncGeneratorFn<T, O = unknown> = (opts?: O) => AsyncGenerator<T>;

type ListStream<T> = ReadableStream<T> & {
  then<R1 = T[], R2 = never>(
    onfulfilled?: ((value: T[]) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2>;
};

// Convert a generator into a ReadablePromise, so that it can be called with
// both "await", ".pipeTo()", or "for await"
export default function listFromGenerator<T, O = unknown>(
  generator: AsyncGeneratorFn<T, O>,
): (opts?: O) => ListStream<T> {
  return (opts?: O): ListStream<T> => {
    const stream = new ReadableStream<T>({
      async start(controller: ReadableStreamDefaultController<T>) {
        for await (const value of generator(opts)) {
          controller.enqueue(value);
        }
        controller.close();
      },
    }) as ListStream<T>;

    let prom: Promise<T[]> | undefined;
    stream.then = (
      fulfilled?: ((value: T[]) => unknown) | null,
      rejected?: ((reason: unknown) => unknown) | null,
    ) => {
      if (prom) return prom as Promise<never>;
      prom = (async () => {
        try {
          const values: T[] = [];
          for await (const value of stream) {
            values.push(value);
          }
          return fulfilled ? fulfilled(values) : values;
        } catch (error) {
          if (rejected) return rejected(error);
          throw error;
        }
      })() as Promise<T[]>;
      return prom as Promise<never>;
    };

    return stream;
  };
}
