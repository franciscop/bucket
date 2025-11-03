function merge(arrays) {
  const totalSize = arrays.reduce((acc, e) => acc + e.length, 0);
  const merged = new Uint8Array(totalSize);

  arrays.forEach((array, i, arrays) => {
    const offset = arrays.slice(0, i).reduce((acc, e) => acc + e.length, 0);
    merged.set(array, offset);
  });

  return Buffer.from(merged);
}

export default function promiseToWritable(cb) {
  const chunks = [];
  return new WritableStream({
    write(chunk) {
      chunks.push(chunk);
    },
    async close() {
      await cb(merge(chunks));
    },
    async abort(reason) {
      await cb(merge(chunks));
    },
  });
}
