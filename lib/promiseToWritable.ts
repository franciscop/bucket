function merge(arrays: Uint8Array[]): Buffer {
  const totalSize = arrays.reduce((acc, e) => acc + e.length, 0);
  const merged = new Uint8Array(totalSize);
  arrays.forEach((array, i, arrays) => {
    const offset = arrays.slice(0, i).reduce((acc, e) => acc + e.length, 0);
    merged.set(array, offset);
  });
  return Buffer.from(merged);
}

export default function promiseToWritable(
  cb: (data: Buffer) => Promise<void> | void,
): WritableStream<Uint8Array> {
  const chunks: Uint8Array[] = [];
  return new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
    async close() {
      await cb(merge(chunks));
    },
    async abort() {
      await cb(merge(chunks));
    },
  });
}
