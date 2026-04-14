// TESTING utils
import { Blob } from "node:buffer";
import { Readable } from "node:stream";

// https://bun.sh/guides/streams/node-readable-to-string
export async function nodeStreamToString(
  stream: NodeJS.ReadableStream,
): Promise<string> {
  return new Response(stream as unknown as BodyInit).text();
}

export async function webStreamToString(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// https://bun.sh/guides/streams/node-readable-to-string
export function textToNodeStream(text: string): Readable {
  return Readable.from([Buffer.from(text)]);
}

// Set chunk size of 1024 bytes
export function textToWebStream(
  text: string,
  size = 1024,
): ReadableStream<Uint8Array> {
  const arr = new TextEncoder().encode(text);
  return new Blob([arr]).stream() as ReadableStream<Uint8Array>;
}
