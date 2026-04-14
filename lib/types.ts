export interface FileInfo {
  id: string | number;
  name: string;
  path: string;
  exists: boolean;
  type: string | null;
  size: number;
  date: Date | null;
  url: string | null;
}

export interface BucketInfo {
  id: string;
  name?: string;
  type?: string;
  path?: string;
  base?: string;
  endpoint?: string;
}

export interface FileEntry {
  id: string;
  name: string;
  path: string;
  type: string | null;
  size: number;
  date: Date | null;
  url?: string | null;
}

export type WriteContent =
  | string
  | Buffer
  | Uint8Array
  | Blob
  | IBucketFile
  | ReadableStream
  | NodeJS.ReadableStream;

export interface IBucketFile {
  id: string | number;
  name: string;
  path: string;
  info(): Promise<FileInfo>;
  exists(): Promise<boolean>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
  bytes(): Promise<Uint8Array>;
  write(content: WriteContent): Promise<void>;
  copy(path: string): Promise<void>;
  move(path: string): Promise<void>;
  rename(name: string): Promise<void>;
  remove(): Promise<void>;
  stream(): ReadableStream;
  nodeReadable(): NodeJS.ReadableStream;
  writable(): WritableStream;
  nodeWritable(): NodeJS.WritableStream;
  publicUrl(): string | null;
  signedUrl(opts: { expires: number | string }): Promise<string | null>;
  uploadUrl(opts: { expires: number | string }): Promise<string | null>;
}

export interface IBucket {
  type?: string;
  info(): Promise<BucketInfo>;
  list(filter?: RegExp | string): Promise<IBucketFile[]>;
  remove(filter?: RegExp | string): Promise<IBucketFile[]>;
  count(filter?: RegExp | string): Promise<number>;
  file(name: string): IBucketFile;
  [Symbol.asyncIterator](): AsyncIterator<IBucketFile>;
}

export interface S3Auth {
  id: string;
  secret: string;
  region: string;
}

export interface S3Request {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string | Buffer;
  params?: Record<string, string | undefined>;
  [key: string]: unknown;
}
