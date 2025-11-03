// TESTING utils
import { Blob } from "node:buffer";
import { Readable } from "node:stream";

// NEW https://bun.sh/guides/streams/node-readable-to-string
export async function nodeStreamToString(stream) {
  return await new Response(stream).text();
}

export async function webStreamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// Okay this is legit amazing
// https://bun.sh/guides/streams/node-readable-to-string
export function textToNodeStream(text) {
  return Readable.from([Buffer.from(text)]);
}

// set chunk size of 1024 bytes
export function textToWebStream(text, size = 1024) {
  const arr = new TextEncoder().encode(text);
  return new Blob([arr]).stream(size);
}
