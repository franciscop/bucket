// Type-level regression tests. Nothing here runs; it exists so `tsc` fails if
// the public `Bucket`/`BucketFile` contract drifts from what the providers
// actually accept. Every method that does I/O takes a signal, and it has to be
// reachable through the declared interface, not just the concrete class.
import Memory from "../src/memory/index.ts";
import type { Bucket, BucketFile } from "../src/lib/types.ts";

const bucket: Bucket = Memory();
const file: BucketFile = bucket.file("a.txt");
const signal = new AbortController().signal;

// ── Readers ─────────────────────────────────────────────────────────────────
void file.info({ signal });
void file.exists({ signal });
void file.text({ signal });
void file.json({ signal });
void file.arrayBuffer({ signal });
void file.blob({ signal });
void file.bytes({ signal });

// ── Streams: synchronous, so the signal is given up front ───────────────────
void file.stream({ signal });
void file.nodeReadable({ signal });
void file.writable({ signal });
void file.nodeWritable({ signal });

// ── Mutators ────────────────────────────────────────────────────────────────
void file.write("x", { signal });
void file.copyTo("b.txt", { signal });
void file.moveTo("c.txt", { signal });
void file.rename("d.txt", { signal });
void file.remove({ signal });
void file.unlink({ signal });

// ── Bucket ──────────────────────────────────────────────────────────────────
void bucket.info({ signal });
void bucket.list(/./, { signal });
void bucket.scan(/./, { signal });
void bucket.count(/./, { signal });
void bucket.remove(/./, { signal });
void bucket.create("x", { signal });

// Every reader and stream is callable with no arguments at all.
void file.text();
void file.stream();
void file.nodeReadable();
void bucket.list();
