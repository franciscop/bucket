// src/lib/BucketError.ts
var CODE_BY_STATUS = {
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT"
};
var BucketError = class extends Error {
  provider;
  status;
  code;
  constructor(message, options) {
    super(
      message,
      options.cause === void 0 ? void 0 : { cause: options.cause }
    );
    this.name = "BucketError";
    this.provider = options.provider;
    this.status = options.status;
    this.code = options.code ?? (options.status === void 0 ? "UNKNOWN" : CODE_BY_STATUS[options.status] ?? "UNKNOWN");
  }
};

// src/lib/prefix.ts
var invalid = (path2) => {
  throw new BucketError(`Invalid path: "${path2}"`, { code: "INVALID_PATH" });
};
var resolvePath = (base, path2) => {
  if (path2.includes("\\")) invalid(path2);
  const out = !path2.startsWith("/") && base ? base.split("/") : [];
  for (const segment of path2.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!out.length)
        throw new BucketError(`Path escapes the bucket: "${path2}"`, {
          code: "INVALID_PATH"
        });
      out.pop();
    } else out.push(segment);
  }
  return out.join("/");
};
var fileKey = (prefix, name) => {
  const key = resolvePath(prefix, name);
  if (!key || prefix && !key.startsWith(prefix + "/")) invalid(name);
  return key;
};
var folderKey = resolvePath;
var destKey = (prefix, dest, name) => {
  const key = resolvePath(prefix, dest.endsWith("/") ? dest + name : dest);
  if (!key) invalid(dest);
  return key;
};
function scope(prefix, filter) {
  const dir = prefix ? prefix + "/" : "";
  return {
    query: dir,
    test: (key) => key.startsWith(dir) && (!filter || filter.test(key.slice(dir.length)))
  };
}

// src/lib/abort.ts
function abortError(signal) {
  const reason = signal?.reason;
  const err = new BucketError(reason?.message || "The operation was aborted", {
    code: "ABORTED",
    cause: reason
  });
  err.name = reason?.name || "AbortError";
  return err;
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}
function rethrow(err, signal) {
  if (signal?.aborted) throw abortError(signal);
  const name = err?.name;
  if (name === "AbortError" || name === "TimeoutError")
    throw abortError(signal);
  throw err;
}
async function withAbort(signal, fn) {
  throwIfAborted(signal);
  try {
    return await fn();
  } catch (err) {
    rethrow(err, signal);
  }
}

// src/lib/config.ts
var invalidConfig = (message) => {
  throw new BucketError(message, { code: "INVALID_CONFIG" });
};
var origin = (url) => (url ?? "").replace(/\/+$/, "");

// src/lib/node.ts
var load = (name) => import(name).catch(() => null);
var stream = await load("node:stream");
var fs = await load("node:fs");
var path = await load("node:path");
var os = await load("node:os");
var fsp = fs?.promises;

// src/lib/chunkedWritable.ts
var Chunker = class {
  #target;
  #pending = [];
  #size = 0;
  #ctx = null;
  #opened = false;
  #parts = [];
  #n = 0;
  #partSize = null;
  constructor(target) {
    this.#target = target;
  }
  async #resolvePartSize() {
    if (this.#partSize === null) {
      const ps = this.#target.partSize;
      this.#partSize = typeof ps === "function" ? await ps() : ps;
    }
    return this.#partSize;
  }
  async write(chunk) {
    this.#pending.push(chunk);
    this.#size += chunk.length;
    const partSize = await this.#resolvePartSize();
    if (this.#size <= partSize) return;
    try {
      if (!this.#opened) {
        this.#ctx = await this.#target.start();
        this.#opened = true;
      }
      while (this.#size > partSize) {
        const all = Buffer.concat(this.#pending);
        const rest = all.subarray(partSize);
        this.#pending = [rest];
        this.#size = rest.length;
        const head = Buffer.from(all.subarray(0, partSize));
        this.#parts.push(
          await this.#target.part(this.#ctx, ++this.#n, head, false)
        );
      }
    } catch (err) {
      await this.#cleanup();
      throw err;
    }
  }
  async close() {
    const data = Buffer.concat(this.#pending);
    this.#pending = [];
    this.#size = 0;
    if (!this.#opened) return this.#target.single(data);
    try {
      this.#parts.push(
        await this.#target.part(this.#ctx, ++this.#n, data, true)
      );
      await this.#target.finish(this.#ctx, this.#parts);
    } catch (err) {
      await this.#cleanup();
      throw err;
    }
  }
  async abort() {
    this.#pending = [];
    this.#size = 0;
    await this.#cleanup();
  }
  async #cleanup() {
    if (!this.#opened) return;
    this.#opened = false;
    const ctx = this.#ctx;
    this.#ctx = null;
    try {
      await this.#target.abort(ctx);
    } catch {
    }
  }
};
function chunkedWritable(target) {
  const chunker = new Chunker(target);
  return new WritableStream({
    write: (chunk) => chunker.write(chunk),
    close: () => chunker.close(),
    abort: () => chunker.abort()
  });
}
async function writeChunked(target, data) {
  const chunker = new Chunker(target);
  await chunker.write(data);
  await chunker.close();
}

// src/lib/http.ts
var RETRIABLE = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
var IDEMPOTENT = /* @__PURE__ */ new Set(["GET", "HEAD", "PUT", "DELETE"]);
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function checkStatus(res, provider, what, ...ok) {
  if (res.ok || ok.includes(res.status)) return res;
  throw new BucketError(`${provider} ${what} error: ${res.status}`, {
    provider,
    status: res.status
  });
}
var Http = class {
  #opts;
  constructor(opts) {
    this.#opts = opts;
  }
  get(url, options) {
    return this.send("GET", url, options);
  }
  head(url, options) {
    return this.send("HEAD", url, options);
  }
  put(url, options) {
    return this.send("PUT", url, options);
  }
  post(url, options) {
    return this.send("POST", url, options);
  }
  delete(url, options) {
    return this.send("DELETE", url, options);
  }
  /** Sends one authorized request, retrying transient failures. The verb
   * methods above are the usual entry; this is for a method held in a variable. */
  async send(method, url, options = {}) {
    const { provider, retries = 2, authorize: authorize2, refresh } = this.#opts;
    const attempts = IDEMPOTENT.has(method.toUpperCase()) ? retries + 1 : 1;
    let attempt = 0;
    let refreshed = false;
    for (; ; ) {
      if (attempt) {
        await sleep(2 ** attempt * 100 * (0.5 + Math.random()));
      }
      const plain = {
        method: method.toUpperCase(),
        url,
        headers: { ...options.headers ?? {} },
        body: options.body
      };
      const req = options.auth === false ? plain : await authorize2(plain);
      let res;
      try {
        res = await withAbort(
          options.signal,
          () => fetch(req.url, {
            method: req.method,
            headers: req.headers,
            body: req.body,
            signal: options.signal
          })
        );
      } catch (err) {
        if (err instanceof BucketError && err.code === "ABORTED") throw err;
        if (++attempt >= attempts) throw err;
        continue;
      }
      if (res.status === 401 && refresh && options.auth !== false && !refreshed) {
        refreshed = true;
        await refresh(req);
        continue;
      }
      if (RETRIABLE.has(res.status) && ++attempt < attempts) continue;
      return options.raw ? res : checkStatus(
        res,
        provider,
        options.what ?? method,
        ...options.ok ?? []
      );
    }
  }
};

// src/lib/parse.ts
var times = /(-?(?:\d+\.?\d*|\d*\.?\d+)(?:e[-+]?\d+)?)\s*([\p{L}]*)/iu;
var parse = function(str) {
  if (str === null || str === void 0) return null;
  if (typeof str === "number") return str;
  const cleaned = str.toLowerCase().replace(/[,_]/g, "");
  const [, value, units] = times.exec(cleaned) || [];
  if (!units) return null;
  const unitValue = parse[units] ?? parse[units.replace(/s$/, "")];
  if (!unitValue) return null;
  return Math.abs(
    Math.round(parseFloat(value) * unitValue * 1e3) / 1e3
  );
};
parse.millisecond = parse.ms = 1e-3;
parse.second = parse.sec = parse.s = parse[""] = 1;
parse.minute = parse.min = parse.m = parse.s * 60;
parse.hour = parse.hr = parse.h = parse.m * 60;
parse.day = parse.d = parse.h * 24;
parse.week = parse.wk = parse.w = parse.d * 7;
parse.year = parse.yr = parse.y = parse.d * 365.25;
parse.month = parse.b = parse.y / 12;
var parse_default = parse;

// src/lib/promiseToReadable.ts
function promiseToReadable(work) {
  if (typeof work === "function") work = work();
  return new ReadableStream({
    async start(controller) {
      for await (const chunk of await work) {
        controller.enqueue(chunk);
      }
      controller.close();
    }
  });
}

// src/lib/publicUrl.ts
function encodePublicPath(path2) {
  return path2.split("/").map(encodeURIComponent).join("/");
}
function publicUrlFrom(base, path2) {
  return `${base.replace(/\/+$/, "")}/${encodePublicPath(path2)}`;
}

// src/lib/filter.ts
var invalid2 = (got, required) => {
  const describe = got === void 0 ? "no filter" : got === null ? "null" : typeof got === "string" ? `the string ${JSON.stringify(got)}` : `a ${typeof got}`;
  throw new BucketError(
    `${required ? "remove() needs" : "expected"} a RegExp filter, got ${describe}. Use .remove(/./) to empty it, .folder(path) to scope it, or a RegExp like .remove(/\\.tmp$/) to match by name.`,
    { code: "INVALID_FILTER" }
  );
};
function assertFilter(filter) {
  if (filter === void 0 || filter instanceof RegExp) return;
  invalid2(filter, false);
}
function requireFilter(filter) {
  if (filter instanceof RegExp) return;
  invalid2(filter, true);
}

// src/lib/mimes.ts
var mimes = {
  aac: "audio/aac",
  abw: "application/x-abiword",
  arc: "application/x-freearc",
  avif: "image/avif",
  avi: "video/x-msvideo",
  azw: "application/vnd.amazon.ebook",
  bin: "application/octet-stream",
  bmp: "image/bmp",
  bz: "application/x-bzip",
  bz2: "application/x-bzip2",
  cda: "application/x-cdf",
  csh: "application/x-csh",
  css: "text/css",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  eot: "application/vnd.ms-fontobject",
  epub: "application/epub+zip",
  gz: "application/gzip",
  heic: "image/heic",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  ico: "image/vnd.microsoft.icon",
  ics: "text/calendar",
  jar: "application/java-archive",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  jsonld: "application/ld+json",
  md: "text/markdown",
  mid: "audio/midi",
  midi: "audio/midi",
  mjs: "text/javascript",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  mpkg: "application/vnd.apple.installer+xml",
  odp: "application/vnd.oasis.opendocument.presentation",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odt: "application/vnd.oasis.opendocument.text",
  oga: "audio/ogg",
  ogv: "video/ogg",
  ogx: "application/ogg",
  opus: "audio/opus",
  otf: "font/otf",
  png: "image/png",
  pdf: "application/pdf",
  php: "application/x-httpd-php",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rar: "application/vnd.rar",
  rtf: "application/rtf",
  sh: "application/x-sh",
  svg: "image/svg+xml",
  tar: "application/x-tar",
  text: "text/plain",
  tif: "image/tiff",
  tiff: "image/tiff",
  ts: "video/mp2t",
  ttf: "font/ttf",
  txt: "text/plain",
  vsd: "application/vnd.visio",
  wav: "audio/wav",
  weba: "audio/webm",
  webm: "video/webm",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xhtml: "application/xhtml+xml",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  xul: "application/vnd.mozilla.xul+xml",
  zip: "application/zip",
  "3gp": "video/3gpp",
  "3g2": "video/3gpp2",
  "7z": "application/x-7z-compressed"
};
var mimes_default = mimes;

// src/lib/contentType.ts
function getContentType(path2) {
  const ext = path2.split(".").pop()?.toLowerCase();
  return ext ? mimes_default[ext] : void 0;
}
var isExtension = (type) => /^\.?[a-zA-Z0-9]+$/.test(type);
var bare = (type) => type.trim().replace(/^\./, "").toLowerCase();
function toMime(type) {
  const value = type.trim();
  if (!value) return void 0;
  return isExtension(value) ? mimes_default[bare(value)] : value;
}
var PREFERRED = {
  "text/html": "html",
  "image/jpeg": "jpg",
  "text/javascript": "js",
  "audio/midi": "mid",
  "text/plain": "txt",
  "image/tiff": "tiff"
};
var extensions = null;
function getExtension(type) {
  const value = type.trim();
  if (!value) return "";
  if (isExtension(value)) return "." + bare(value);
  if (!extensions) {
    extensions = { ...PREFERRED };
    for (const [ext2, mime] of Object.entries(mimes_default)) extensions[mime] ??= ext2;
  }
  const ext = extensions[value.split(";")[0].trim().toLowerCase()];
  return ext ? "." + ext : "";
}
function resolveContentType(path2, content, options) {
  return (options?.type ? toMime(options.type) : void 0) ?? getContentType(path2) ?? (content instanceof Blob && content.type ? content.type : void 0);
}

// src/lib/nanoid.ts
var ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function nanoid(size = 21) {
  let id = "";
  while (id.length < size) {
    for (const byte of crypto.getRandomValues(new Uint8Array(size))) {
      if (byte < 248 && id.length < size) id += ALPHABET[byte % 62];
    }
  }
  return id;
}
function randomName(content, options) {
  if (options?.type) {
    const ext2 = getExtension(options.type);
    if (ext2) return nanoid() + ext2;
  }
  const named = content;
  const source = typeof named?.name === "string" ? named.name : "";
  const dot = source.lastIndexOf(".");
  const ext = dot > 0 ? source.slice(dot) : "";
  return nanoid() + (/^\.[a-zA-Z0-9]{1,12}$/.test(ext) ? ext : "");
}

// src/lib/range.ts
function composeRange(base, start, end) {
  const baseStart = base?.start ?? 0;
  const baseEnd = base?.end;
  const s = baseStart + Math.max(0, start);
  let e;
  if (end === void 0) {
    e = baseEnd;
  } else {
    e = baseStart + Math.max(0, end);
    if (baseEnd !== void 0) e = Math.min(e, baseEnd);
  }
  if (e !== void 0 && e < s) e = s;
  return e === void 0 ? { start: s } : { start: s, end: e };
}
function isEmptyRange(range) {
  return range.end !== void 0 && range.end <= range.start;
}
function rangeHeader(range) {
  if (isEmptyRange(range)) return null;
  const last = range.end !== void 0 ? range.end - 1 : "";
  return `bytes=${range.start}-${last}`;
}
function rangeSize(range, total) {
  if (!range) return total;
  const from = Math.min(range.start, total);
  const to = range.end === void 0 ? total : Math.min(range.end, total);
  return Math.max(0, to - from);
}

// src/lib/writeMeta.ts
function writeMeta(path2, options = {}, content) {
  return {
    type: resolveContentType(path2, content, options) ?? null,
    cacheControl: options.cacheControl,
    disposition: options.disposition,
    metadata: Object.fromEntries(
      Object.entries(options.metadata ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        v
      ])
    )
  };
}
function metaHeaders(meta, names) {
  const out = {};
  if (names.type && meta.type) out[names.type] = meta.type;
  if (names.cacheControl && meta.cacheControl)
    out[names.cacheControl] = meta.cacheControl;
  if (names.disposition && meta.disposition)
    out[names.disposition] = meta.disposition;
  if (names.metaPrefix !== void 0)
    for (const [k, v] of Object.entries(meta.metadata))
      out[names.metaPrefix + k] = v;
  return out;
}

// src/lib/base.ts
var expiresIn = (opts) => parse_default(opts.expires) ?? 3600;
var BaseFile = class {
  name;
  path;
  ctx;
  range = null;
  constructor(path2, ctx) {
    this.path = path2.startsWith("/") ? path2.slice(1) : path2;
    this.name = this.path.split("/").pop() || this.path;
    this.ctx = ctx;
  }
  // ── Derived ───────────────────────────────────────────────────────────────
  get provider() {
    return this.ctx.provider;
  }
  /** A fresh handle for another key in the same bucket scope. */
  at(path2) {
    const Self = this.constructor;
    return new Self(path2, this.ctx);
  }
  /** Throws a BucketError unless the response is ok or in `also`. */
  check(res, what, ...also) {
    return checkStatus(res, this.provider, what, ...also);
  }
  /** The write options, resolved into the shape every provider maps from. */
  meta(options, content) {
    return writeMeta(this.path, options, content);
  }
  slice(start, end) {
    const f = this.at(this.path);
    f.range = composeRange(this.range, start, end);
    return f;
  }
  async get(opts) {
    throwIfAborted(opts?.signal);
    if (this.range && isEmptyRange(this.range))
      return new Response(new Uint8Array(0));
    return this.fetch(opts);
  }
  async exists(opts) {
    throwIfAborted(opts?.signal);
    return await this.info(opts) !== null;
  }
  async text(opts) {
    return (await this.get(opts)).text();
  }
  async json(opts) {
    return (await this.get(opts)).json();
  }
  async arrayBuffer(opts) {
    return (await this.get(opts)).arrayBuffer();
  }
  async blob(opts) {
    return (await this.get(opts)).blob();
  }
  async bytes(opts) {
    return new Uint8Array(await this.arrayBuffer(opts));
  }
  async write(content, options = {}) {
    await withAbort(options.signal, () => this.dispatch(content, options));
    return this;
  }
  async dispatch(content, options) {
    if (typeof content === "string" || content instanceof Uint8Array)
      await writeChunked(this.target(options), Buffer.from(content));
    else if (content instanceof Blob)
      await writeChunked(
        this.target({
          ...options,
          type: this.meta(options, content).type ?? void 0
        }),
        Buffer.from(await content.arrayBuffer())
      );
    else if (typeof content.info === "function")
      await content.stream().pipeTo(this.writable(options));
    else if (typeof content.pipeTo === "function")
      await content.pipeTo(this.writable(options));
    else if (stream && content instanceof stream.Readable)
      await stream.Readable.toWeb(content).pipeTo(this.writable(options));
    else
      throw new BucketError(
        "write() needs a string, Buffer, Blob, stream, or a file from any bucket",
        { code: "INVALID_CONTENT" }
      );
  }
  async copyTo(dest, opts) {
    throwIfAborted(opts?.signal);
    if (typeof dest !== "string") return dest.write(this, opts);
    const key = destKey(this.ctx.prefix, dest, this.name);
    await this.copy(key, opts);
    return this.at(key);
  }
  async remove(opts) {
    throwIfAborted(opts?.signal);
    await this.delete(opts);
    return this;
  }
  async moveTo(dest, opts) {
    const moved = await this.copyTo(dest, opts);
    await this.remove(opts);
    return moved;
  }
  async rename(name, opts) {
    if (!name || name === "." || name === "..")
      throw new BucketError(`rename() needs a file name, got "${name}"`, {
        code: "INVALID_PATH"
      });
    if (name.includes("/"))
      throw new BucketError(
        "rename() cannot change directory, use moveTo() instead",
        { code: "INVALID_PATH" }
      );
    const rel = this.ctx.prefix ? this.path.slice(this.ctx.prefix.length + 1) : this.path;
    const dir = rel.split("/").slice(0, -1).join("/");
    return this.moveTo(dir ? dir + "/" + name : name, opts);
  }
  // Bun-style alias, so muscle memory from Bun's S3File carries over
  unlink(opts) {
    return this.remove(opts);
  }
  stream(opts) {
    return promiseToReadable(async () => (await this.get(opts)).body);
  }
  // The node* methods are the one place a missing Node runtime is an error.
  #node() {
    if (!stream)
      throw new BucketError("Node streams are not available in this runtime", {
        code: "INVALID_CONTENT"
      });
    return stream;
  }
  nodeReadable(opts) {
    return this.#node().Readable.fromWeb(
      this.stream(
        opts
      )
    );
  }
  writable(options = {}) {
    return chunkedWritable(this.target(options));
  }
  nodeWritable(options) {
    return this.#node().Writable.fromWeb(
      this.writable(options)
    );
  }
  async publicUrl() {
    return this.ctx.publicUrl ? publicUrlFrom(this.ctx.publicUrl, this.path) : this.canonicalUrl();
  }
};
function wholeBody(put) {
  return {
    partSize: Infinity,
    single: put,
    start: async () => void 0,
    part: async () => void 0,
    finish: async () => {
    },
    abort: async () => {
    }
  };
}
var BaseBucket = class {
  ctx;
  constructor(ctx) {
    this.ctx = ctx;
  }
  // ── Derived ───────────────────────────────────────────────────────────────
  get PREFIX() {
    return this.ctx.prefix;
  }
  /** Throws a BucketError unless the response is ok or in `also`. */
  check(res, what, ...also) {
    return checkStatus(res, this.ctx.provider, what, ...also);
  }
  file(name) {
    if (!name)
      throw new BucketError("file() needs a name", { code: "INVALID_PATH" });
    return this.make(fileKey(this.PREFIX, name));
  }
  folder(path2) {
    const Self = this.constructor;
    return new Self({ ...this.ctx, prefix: folderKey(this.PREFIX, path2) });
  }
  /** Deletes the listed files, returning the ones confirmed gone. Overridden
   * where the provider has a batch delete. */
  async removeAll(files, opts) {
    await Promise.all(files.map((f) => f.remove(opts)));
    return files;
  }
  scan(filter, opts) {
    assertFilter(filter);
    throwIfAborted(opts?.signal);
    return this.iterate(filter, opts);
  }
  async *iterate(filter, opts) {
    for await (const page of this.pages(filter, opts)) {
      for (const file of page) {
        throwIfAborted(opts?.signal);
        yield file;
      }
    }
  }
  async list(filter, opts) {
    assertFilter(filter);
    throwIfAborted(opts?.signal);
    const files = [];
    for await (const page of this.pages(filter, opts)) files.push(...page);
    return files;
  }
  async count(filter, opts) {
    return (await this.list(filter, opts)).length;
  }
  async remove(filter, opts) {
    requireFilter(filter);
    throwIfAborted(opts?.signal);
    const files = await this.list(filter, opts);
    return files.length ? this.removeAll(files, opts) : [];
  }
  async create(content, options) {
    throwIfAborted(options?.signal);
    return this.file(randomName(content, options)).write(content, options);
  }
  async *[Symbol.asyncIterator]() {
    yield* this.scan();
  }
};

// src/fs/osPathGuard.ts
function assertNotOsPath(root, path2) {
  if (path2 !== root && !path2.startsWith(root + "/")) return;
  const rest = path2.slice(root.length).replace(/^\/+/, "");
  throw new BucketError(
    `"${path2}" looks like an OS path; paths are relative to the bucket ("${root}")` + (rest ? `. Did you mean "${rest}"?` : ""),
    { code: "INVALID_PATH" }
  );
}

// src/fs/File.ts
function fsError(err) {
  if (err instanceof BucketError) throw err;
  const code = err.code;
  throw new BucketError(err.message, {
    provider: "FILESYSTEM",
    code: code === "ENOENT" ? "NOT_FOUND" : code === "EACCES" || code === "EPERM" ? "FORBIDDEN" : "UNKNOWN",
    cause: err
  });
}
var FSFile = class extends BaseFile {
  // The OS location is private; derive it externally with join(root, file.path).
  get #abs() {
    return path.join(this.ctx.root, this.path);
  }
  // Wraps the bytes as a Response so the shared readers work unchanged; the
  // content type comes from the extension, as there is no metadata store.
  async fetch(opts) {
    const type = getContentType(this.path);
    return new Response(new Uint8Array(await this.#read(opts?.signal)), {
      headers: type ? { "content-type": type } : {}
    });
  }
  async #read(signal) {
    if (!this.range)
      return withAbort(
        signal,
        () => fsp.readFile(this.#abs, { signal })
      ).catch(fsError);
    const { start, end } = this.range;
    const fh = await fsp.open(this.#abs).catch(fsError);
    try {
      const size = (await fh.stat()).size;
      const from = Math.min(start, size);
      const to = end === void 0 ? size : Math.min(end, size);
      const len = Math.max(0, to - from);
      const buf = Buffer.alloc(len);
      if (len > 0) await fh.read(buf, 0, len, from);
      return buf;
    } finally {
      await fh.close();
    }
  }
  async info(opts) {
    throwIfAborted(opts?.signal);
    let stat;
    try {
      stat = await fsp.stat(this.#abs);
    } catch {
      return null;
    }
    return {
      size: rangeSize(this.range, stat.size),
      type: getContentType(this.path) ?? null,
      modified: new Date(stat.mtime),
      version: null,
      metadata: {}
    };
  }
  // The filesystem has no metadata store, so every write option but the
  // bytes is dropped; node.fsp.writeFile with a signal removes a partial file itself.
  async put(data, options) {
    await fsp.mkdir(path.dirname(this.#abs), { recursive: true });
    await fsp.writeFile(this.#abs, data, { signal: options.signal });
  }
  target(options) {
    return wholeBody((data) => this.put(data, options));
  }
  // The OS-path guard runs on the raw destination, before the base resolves it.
  copyTo(dest, opts) {
    if (typeof dest === "string") assertNotOsPath(this.ctx.root, dest);
    return super.copyTo(dest, opts);
  }
  async copy(key) {
    const dst = this.at(key);
    await fsp.mkdir(path.dirname(dst.#abs), { recursive: true });
    await fsp.copyFile(this.#abs, dst.#abs).catch(fsError);
  }
  // A single atomic rename rather than copy + unlink.
  async moveTo(dest, opts) {
    throwIfAborted(opts?.signal);
    if (typeof dest !== "string") return super.moveTo(dest, opts);
    assertNotOsPath(this.ctx.root, dest);
    const dst = this.at(destKey(this.ctx.prefix, dest, this.name));
    await fsp.mkdir(path.dirname(dst.#abs), { recursive: true });
    await fsp.rename(this.#abs, dst.#abs).catch(fsError);
    return dst;
  }
  async delete() {
    await fsp.unlink(this.#abs).catch((err) => {
      if (err.code !== "ENOENT") fsError(err);
    });
  }
  // Nothing canonical: the library does not serve the files.
  async canonicalUrl() {
    return null;
  }
  async signedUrl(_opts) {
    return null;
  }
  async uploadUrl(_opts) {
    return null;
  }
  // Streams straight from disk instead of buffering the whole file.
  stream(opts) {
    return stream.Readable.toWeb(
      this.nodeReadable(opts)
    );
  }
  nodeReadable(opts) {
    const signal = opts?.signal;
    if (!this.range) return fs.createReadStream(this.#abs, { signal });
    if (isEmptyRange(this.range)) return stream.Readable.from([]);
    const { start, end } = this.range;
    return fs.createReadStream(this.#abs, {
      start,
      signal,
      ...end !== void 0 ? { end: end - 1 } : {}
    });
  }
  writable(_options) {
    const finalPath = this.#abs;
    const tmpPath = `${finalPath}.tmp-${Math.random().toString(36).slice(2)}`;
    let writer = null;
    return new WritableStream({
      async start() {
        await fsp.mkdir(path.dirname(finalPath), {
          recursive: true
        });
        writer = fs.createWriteStream(tmpPath);
        await new Promise((resolve, reject) => {
          writer.once("open", resolve);
          writer.once("error", reject);
        });
      },
      write(chunk) {
        return new Promise((resolve, reject) => {
          const ok = writer.write(chunk);
          if (ok) resolve();
          else writer.once("drain", resolve);
          writer.once("error", reject);
        });
      },
      async close() {
        await new Promise((resolve, reject) => {
          writer.end((err) => err ? reject(err) : resolve());
        });
        await fsp.rename(tmpPath, finalPath);
      },
      async abort() {
        writer?.destroy();
        await fsp.unlink(tmpPath).catch(() => {
        });
      }
    });
  }
};

// src/fs/index.ts
var { FS_PUBLIC_URL: ENV_PUBLIC_URL } = process.env;
var FileSystemBucket = class extends BaseBucket {
  type = "FILESYSTEM";
  // OS directory of the current scope (the root plus the folder prefix).
  get path() {
    return path.join(this.ctx.root, this.PREFIX);
  }
  make(key) {
    return new FSFile(key, this.ctx);
  }
  file(name) {
    assertNotOsPath(this.ctx.root, name);
    return super.file(name);
  }
  folder(path2) {
    assertNotOsPath(this.ctx.root, path2);
    return super.folder(path2);
  }
  async info(opts) {
    throwIfAborted(opts?.signal);
    return {
      type: this.type,
      name: path.basename(this.path) || this.path,
      url: this.path,
      id: os.userInfo().username
    };
  }
  // The filesystem has no pagination: readdir returns everything at once.
  async *pages(filter) {
    const s = scope(this.PREFIX, filter);
    let raw;
    try {
      raw = await fsp.readdir(this.path, {
        recursive: true,
        withFileTypes: true
      });
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    yield raw.filter((d) => d.isFile()).map((d) => {
      const dir = d.parentPath ?? d.path;
      const rel = path.relative(this.path, path.join(dir, d.name)).split(path.sep).join("/");
      return this.PREFIX ? `${this.PREFIX}/${rel}` : rel;
    }).filter((key) => !/\.tmp-[a-z0-9]+$/.test(key) && s.test(key)).sort((a, b) => a.localeCompare(b)).map((key) => this.make(key));
  }
};
function FileSystem(path2, config = {}) {
  if (!fs || !path || !os)
    throw new BucketError(
      "FileSystem needs Node, which this runtime does not provide",
      { code: "INVALID_CONFIG" }
    );
  const ctx = {
    provider: "FILESYSTEM",
    prefix: "",
    publicUrl: origin(config.publicUrl ?? ENV_PUBLIC_URL),
    root: path.resolve(path2)
  };
  return new FileSystemBucket(ctx);
}

// src/lib/encodeS3Path.ts
function encodeS3Path(path2) {
  return path2.replace(
    /[!'()*&<>]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

// src/lib/webcrypto.ts
var enc = new TextEncoder();
var src = (data) => typeof data === "string" ? enc.encode(data) : data;
function toHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
function toBase64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
var toBase64Url = (bytes) => toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
var base64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
async function sha256hex(data) {
  const buf = await crypto.subtle.digest("SHA-256", src(data));
  return toHex(new Uint8Array(buf));
}
async function sha1hex(data) {
  const buf = await crypto.subtle.digest("SHA-1", src(data));
  return toHex(new Uint8Array(buf));
}
async function hmacSha256(key, data) {
  const k = await crypto.subtle.importKey(
    "raw",
    src(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, src(data)));
}
async function importRsaPkcs8(pem) {
  const der = base64ToBytes(
    pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "")
  );
  return crypto.subtle.importKey(
    "pkcs8",
    src(der),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}
async function rsaSha256(key, data) {
  return new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, src(data))
  );
}
async function sha256base64(data) {
  const buf = await crypto.subtle.digest("SHA-256", src(data));
  return toBase64(new Uint8Array(buf));
}

// src/lib/sigv4.ts
var basicDate = () => (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
var ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
var signedHeaders = (headers) => Object.keys(headers).map((k) => k.toLowerCase()).sort(ordinal).join(";");
function canonicalRequest(method, path2, query, headers, payloadHash) {
  const sorted = Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim()]).sort(([a], [b]) => ordinal(a, b));
  return [
    method.toUpperCase(),
    path2,
    query,
    sorted.map(([k, v]) => `${k}:${v}`).join("\n") + "\n",
    sorted.map(([k]) => k).join(";"),
    payloadHash
  ].join("\n");
}
var scopeOf = (timestamp, region) => `${timestamp.slice(0, 8)}/${region}/s3/aws4_request`;
async function signature(secret, timestamp, region, canonical) {
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scopeOf(timestamp, region),
    await sha256hex(canonical)
  ].join("\n");
  let key = `AWS4${secret}`;
  for (const part of [timestamp.slice(0, 8), region, "s3", "aws4_request"])
    key = await hmacSha256(key, part);
  return toHex(await hmacSha256(key, stringToSign));
}

// src/lib/signS3.ts
async function signS3(req, auth) {
  if (!auth.id || !auth.secret)
    throw new BucketError("S3 signing needs an access key id and secret", {
      code: "INVALID_CONFIG"
    });
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? void 0 : req.body;
  const payload = await sha256hex(body ?? "");
  const headers = {
    ...req.headers,
    // .host (not .hostname) so a non-default port is signed, as MinIO and
    // other S3-compatible endpoints require.
    host: url.host,
    "x-amz-content-sha256": payload,
    "x-amz-date": req.headers["x-amz-date"] || basicDate(),
    ...auth.sessionToken ? { "x-amz-security-token": auth.sessionToken } : {}
  };
  const timestamp = headers["x-amz-date"];
  url.searchParams.sort();
  const canonical = canonicalRequest(
    method,
    encodeS3Path(url.pathname),
    url.searchParams.toString(),
    headers,
    payload
  );
  const sig = await signature(auth.secret, timestamp, auth.region, canonical);
  const credential = `${auth.id}/${timestamp.slice(0, 8)}/${auth.region}/s3/aws4_request`;
  return {
    ...req,
    method,
    body,
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${credential},SignedHeaders=${signedHeaders(headers)},Signature=${sig}`
    }
  };
}

// src/lib/xml.ts
var ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;"
};
var ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'"
};
var escapeXml = (text) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
function extractTags(xmlStr, tag) {
  const results = [];
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  let match;
  while ((match = regex.exec(xmlStr)) !== null) results.push(match[1]);
  return results;
}
function getTag(xmlStr, tag) {
  return extractTags(xmlStr, tag)[0] ?? "";
}
var unescapeXml = (text) => text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (all, entity) => {
  if (entity[0] === "#") {
    const code = entity[1] === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return String.fromCodePoint(code);
  }
  return ENTITIES[entity] ?? all;
});

// src/lib/presignS3.ts
async function presignS3(url, method, auth, expiresSeconds) {
  const u = new URL(url);
  const timestamp = basicDate();
  u.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  u.searchParams.set(
    "X-Amz-Credential",
    `${auth.id}/${scopeOf(timestamp, auth.region)}`
  );
  u.searchParams.set("X-Amz-Date", timestamp);
  u.searchParams.set("X-Amz-Expires", String(expiresSeconds));
  u.searchParams.set("X-Amz-SignedHeaders", "host");
  if (auth.sessionToken)
    u.searchParams.set("X-Amz-Security-Token", auth.sessionToken);
  u.searchParams.sort();
  const canonical = canonicalRequest(
    method,
    encodeS3Path(u.pathname),
    u.searchParams.toString(),
    { host: u.host },
    "UNSIGNED-PAYLOAD"
  );
  u.searchParams.set(
    "X-Amz-Signature",
    await signature(auth.secret, timestamp, auth.region, canonical)
  );
  return u.toString();
}

// src/lib/multipartS3.ts
var S3_PART_SIZE = 8 * 1024 * 1024;
function request(o, method, query, body, headers = {}, signal = o.signal) {
  const url = new URL(o.url);
  for (const [key, value] of Object.entries(query))
    url.searchParams.set(key, value);
  return o.http.send(method, url.toString(), {
    body,
    headers,
    signal,
    what: "multipart"
  });
}
function multipartS3(o) {
  return {
    partSize: S3_PART_SIZE,
    single: o.single,
    async start() {
      const res = await request(
        o,
        "POST",
        { uploads: "" },
        void 0,
        o.headers
      );
      const uploadId = getTag(await res.text(), "UploadId");
      if (!uploadId)
        throw new BucketError(`${o.provider} multipart start: no UploadId`, {
          provider: o.provider
        });
      return uploadId;
    },
    async part(uploadId, n, data) {
      const res = await request(
        o,
        "PUT",
        { partNumber: String(n), uploadId },
        data
      );
      const etag = res.headers.get("etag") ?? "";
      await res.text();
      return etag;
    },
    async finish(uploadId, etags) {
      const body = "<CompleteMultipartUpload>" + etags.map(
        (etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`
      ).join("") + "</CompleteMultipartUpload>";
      const res = await request(o, "POST", { uploadId }, body);
      const xml = await res.text();
      if (extractTags(xml, "Error").length)
        throw new BucketError(
          `${o.provider} multipart complete error: ${getTag(xml, "Message") || getTag(xml, "Code")}`,
          { provider: o.provider }
        );
    },
    async abort(uploadId) {
      await request(o, "DELETE", { uploadId }, void 0, {}, void 0);
    }
  };
}

// src/lib/meta.ts
function metaFromHeaders(headers, prefix, skip) {
  const meta = {};
  for (const [key, value] of headers) {
    if (!key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length);
    if (skip?.(name)) continue;
    meta[name] = value;
  }
  return meta;
}
function metaExtras(cacheControl, disposition) {
  return {
    ...cacheControl ? { cacheControl } : {},
    ...disposition ? { disposition } : {}
  };
}

// src/lib/TokenCache.ts
var TokenCache = class {
  #resolve;
  #value = null;
  #expiry = 0;
  /** `resolve` returns the credential and the epoch millis it expires at. */
  constructor(resolve) {
    this.#resolve = resolve;
  }
  async get() {
    if (this.#value !== null && Date.now() < this.#expiry) return this.#value;
    [this.#value, this.#expiry] = await this.#resolve();
    return this.#value;
  }
};

// src/lib/s3like.ts
function s3Context(config, prefix = "") {
  const url = config.endpoint ? `${config.endpoint}/${config.name}` : `https://${config.name}.s3.${config.region}.amazonaws.com`;
  const auth = new TokenCache(async () => {
    if (config.auth) return [config.auth, Infinity];
    const resolved = await config.resolveAuth(config.region);
    return [resolved, resolved.expiry - 6e4];
  });
  return {
    provider: config.type,
    prefix,
    publicUrl: config.publicUrl,
    config,
    url,
    auth,
    http: new Http({
      provider: config.type,
      authorize: async (req) => signS3(req, await auth.get())
    })
  };
}
var makeUrl = (ctx, path2 = "") => {
  const clean = path2 ? path2.startsWith("/") ? path2 : "/" + path2 : "";
  return ctx.url + encodeS3Path(clean);
};
var S3LikeBucket = class extends BaseBucket {
  type;
  constructor(ctx) {
    super(ctx);
    this.type = ctx.provider;
  }
  make(key) {
    return new S3LikeFile(key, this.ctx);
  }
  async info(opts) {
    throwIfAborted(opts?.signal);
    return {
      type: this.type,
      name: this.ctx.config.name,
      url: this.ctx.url,
      id: (await this.ctx.auth.get()).id
    };
  }
  async *pages(filter, opts) {
    let token;
    const s = scope(this.PREFIX, filter);
    do {
      throwIfAborted(opts?.signal);
      const url = new URL(makeUrl(this.ctx));
      url.searchParams.set("list-type", "2");
      if (s.query) url.searchParams.set("prefix", s.query);
      if (token) url.searchParams.set("continuation-token", token);
      const res = await this.ctx.http.get(url.toString(), {
        signal: opts?.signal,
        what: "list"
      });
      const xml = await res.text();
      yield extractTags(xml, "Contents").map((item) => unescapeXml(getTag(item, "Key"))).filter((key) => s.test(key)).map((key) => this.make(key));
      token = getTag(xml, "IsTruncated") === "true" ? getTag(xml, "NextContinuationToken") : void 0;
    } while (token);
  }
  // DeleteObjects: up to 1000 keys per request, returning the confirmed ones.
  async removeAll(files, opts) {
    const deleted = [];
    for (let i = 0; i < files.length; i += 1e3) {
      const batch = files.slice(i, i + 1e3);
      const body = "<Delete>" + batch.map((f) => `<Object><Key>${escapeXml(f.path)}</Key></Object>`).join("") + "</Delete>";
      const url = new URL(makeUrl(this.ctx));
      url.searchParams.set("delete", "");
      const res = await this.ctx.http.post(url.toString(), {
        body,
        // Required body integrity header; S3/R2/MinIO 400 without it.
        headers: { "x-amz-checksum-sha256": await sha256base64(body) },
        signal: opts?.signal,
        what: "delete"
      });
      const keys = extractTags(await res.text(), "Deleted").map(
        (d) => unescapeXml(getTag(d, "Key"))
      );
      deleted.push(...batch.filter((f) => keys.includes(f.path)));
    }
    return deleted;
  }
};
var S3LikeFile = class extends BaseFile {
  #url(path2) {
    return makeUrl(this.ctx, path2);
  }
  async fetch(opts) {
    const rh = this.range && rangeHeader(this.range);
    return this.ctx.http.get(this.#url(this.path), {
      headers: rh ? { Range: rh } : {},
      signal: opts?.signal
    });
  }
  async info(opts) {
    throwIfAborted(opts?.signal);
    const res = await this.ctx.http.head(this.#url(this.path), {
      signal: opts?.signal,
      ok: [404],
      what: "HEAD"
    });
    if (res.status === 404) return null;
    return {
      size: rangeSize(
        this.range,
        parseInt(res.headers.get("content-length") ?? "0", 10)
      ),
      type: res.headers.get("content-type"),
      modified: new Date(res.headers.get("last-modified") ?? Date.now()),
      version: res.headers.get("x-amz-version-id"),
      metadata: metaFromHeaders(res.headers, "x-amz-meta-"),
      ...metaExtras(
        res.headers.get("cache-control"),
        res.headers.get("content-disposition")
      )
    };
  }
  #putHeaders(options) {
    return metaHeaders(this.meta(options), {
      type: "Content-Type",
      cacheControl: "Cache-Control",
      disposition: "Content-Disposition",
      metaPrefix: "x-amz-meta-"
    });
  }
  async put(data, options) {
    await this.ctx.http.put(this.#url(this.path), {
      body: data,
      headers: this.#putHeaders(options),
      signal: options.signal,
      what: "PUT"
    });
  }
  target(options) {
    return multipartS3({
      provider: this.provider,
      url: makeUrl(this.ctx, this.path),
      http: this.ctx.http,
      headers: this.#putHeaders(options),
      single: (data) => this.put(data, options),
      signal: options.signal
    });
  }
  async copy(key, opts) {
    await this.ctx.http.put(this.#url(key), {
      headers: {
        "x-amz-copy-source": `/${this.ctx.config.name}/${this.path}`
      },
      signal: opts?.signal,
      what: "COPY"
    });
  }
  async delete(opts) {
    await this.ctx.http.delete(this.#url(this.path), {
      signal: opts?.signal,
      ok: [404, 204],
      what: "DELETE"
    });
  }
  async canonicalUrl() {
    return this.ctx.config.canonicalPublic ? publicUrlFrom(this.ctx.url, this.path) : null;
  }
  async #presign(method, opts) {
    const auth = await this.ctx.auth.get();
    return presignS3(
      makeUrl(this.ctx, this.path),
      method,
      auth,
      expiresIn(opts)
    );
  }
  signedUrl(opts) {
    return this.#presign("GET", opts);
  }
  uploadUrl(opts) {
    return this.#presign("PUT", opts);
  }
};

// src/s3/index.ts
var {
  AWS_BUCKET: ENV_BUCKET,
  AWS_ACCESS_KEY_ID: ENV_ID,
  AWS_SECRET_ACCESS_KEY: ENV_KEY,
  AWS_SESSION_TOKEN: ENV_SESSION_TOKEN,
  AWS_REGION: ENV_REGION,
  AWS_ENDPOINT_URL: ENV_ENDPOINT,
  AWS_PUBLIC_URL: ENV_PUBLIC_URL2
} = process.env;
async function fetchInstanceCredentials(region) {
  const toCache = (data) => ({
    id: data.AccessKeyId,
    secret: data.SecretAccessKey,
    sessionToken: data.Token,
    region,
    expiry: new Date(data.Expiration).getTime()
  });
  const json = async (res, what) => {
    if (!res.ok)
      throw new BucketError(`S3 could not fetch ${what} credentials`, {
        provider: "S3",
        status: res.status,
        code: "UNAUTHORIZED"
      });
    return toCache(await res.json());
  };
  const fullUri = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  if (fullUri) {
    const token = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    const headers2 = token ? { Authorization: token } : {};
    return json(await fetch(fullUri, { headers: headers2 }), "container");
  }
  const relUri = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  if (relUri)
    return json(await fetch(`http://169.254.170.2${relUri}`), "container");
  const imds = "http://169.254.169.254/latest";
  let headers = {};
  try {
    const r = await fetch(`${imds}/api/token`, {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" }
    });
    if (r.ok) headers = { "X-aws-ec2-metadata-token": await r.text() };
  } catch {
  }
  const roleRes = await fetch(`${imds}/meta-data/iam/security-credentials/`, {
    headers
  });
  if (!roleRes.ok)
    throw new BucketError(
      "No IAM role found. Is this an EC2 instance with an instance profile?",
      { provider: "S3", status: roleRes.status, code: "UNAUTHORIZED" }
    );
  const role = (await roleRes.text()).trim().split("\n")[0];
  return json(
    await fetch(`${imds}/meta-data/iam/security-credentials/${role}`, {
      headers
    }),
    "EC2 instance"
  );
}
function S3(bucket = ENV_BUCKET || "", {
  id = ENV_ID || "",
  secret = ENV_KEY || "",
  region = ENV_REGION || "us-east-1",
  url,
  publicUrl = ENV_PUBLIC_URL2 || "",
  sessionToken = ENV_SESSION_TOKEN
} = {}) {
  if (!bucket)
    invalidConfig(
      "S3 needs a bucket name, as the first argument or AWS_BUCKET."
    );
  const config = {
    type: "S3",
    name: bucket,
    region,
    endpoint: origin(url ?? ENV_ENDPOINT),
    publicUrl: origin(publicUrl),
    auth: id && secret ? { id, secret, region, sessionToken } : null,
    resolveAuth: fetchInstanceCredentials,
    canonicalPublic: true
  };
  const ctx = s3Context(config);
  return new S3LikeBucket(ctx);
}

// src/r2/index.ts
var {
  R2_BUCKET: ENV_BUCKET2,
  R2_URL: ENV_URL,
  R2_ACCOUNT_ID: ENV_ACCOUNT,
  R2_ACCESS_KEY_ID: ENV_ID2,
  R2_SECRET_ACCESS_KEY: ENV_KEY2,
  R2_SESSION_TOKEN: ENV_SESSION_TOKEN2,
  R2_REGION: ENV_REGION2,
  R2_PUBLIC_URL: ENV_PUBLIC_URL3
} = process.env;
var endpointFor = (account) => `https://${account}.r2.cloudflarestorage.com`;
function CloudflareR2(name = ENV_BUCKET2 || "", {
  id = ENV_ID2 || "",
  secret = ENV_KEY2 || "",
  region = ENV_REGION2 || "auto",
  sessionToken = ENV_SESSION_TOKEN2,
  account = ENV_ACCOUNT || "",
  url = ENV_URL || "",
  publicUrl = ENV_PUBLIC_URL3 || ""
} = {}) {
  if (!name)
    invalidConfig(
      "R2 needs a bucket name, as the first argument or R2_BUCKET."
    );
  const custom = origin(url);
  if (account && custom && custom !== endpointFor(account))
    invalidConfig(
      `R2 account "${account}" implies the endpoint ${endpointFor(account)}, which does not match url "${custom}". Pass one or the other.`
    );
  if (!account && !custom)
    invalidConfig(
      "R2 needs an account id (or R2_ACCOUNT_ID) to build its endpoint, or a url for a custom endpoint."
    );
  const config = {
    type: "R2",
    name,
    region,
    endpoint: custom || endpointFor(account),
    publicUrl: origin(publicUrl),
    auth: { id, secret, region, sessionToken },
    canonicalPublic: false
  };
  const ctx = s3Context(config);
  return new S3LikeBucket(ctx);
}

// src/lib/signGCS.ts
var enc2 = new TextEncoder();
var b64urlJson = (o) => toBase64Url(enc2.encode(JSON.stringify(o)));
async function getAccessToken(auth) {
  const now = Math.floor(Date.now() / 1e3);
  const header = b64urlJson({ alg: "RS256", typ: "JWT" });
  const payload = b64urlJson({
    iss: auth.clientEmail,
    scope: "https://www.googleapis.com/auth/devstorage.read_write",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  });
  const key = await importRsaPkcs8(auth.privateKey);
  const signature2 = toBase64Url(await rsaSha256(key, `${header}.${payload}`));
  const jwt = `${header}.${payload}.${signature2}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });
  const data = await res.json();
  return data.access_token;
}
async function getMetadataToken() {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  if (!res.ok)
    throw new BucketError("GCS metadata server error: " + res.status, {
      provider: "GCS",
      status: res.status,
      code: "UNAUTHORIZED"
    });
  const { access_token } = await res.json();
  return access_token;
}
async function presignGCS(bucket, objectPath, auth, method, expiresSeconds) {
  const timestamp = basicDate();
  const scope2 = `${timestamp.slice(0, 8)}/auto/storage/goog4_request`;
  const host = "storage.googleapis.com";
  const path2 = `/${bucket}/${objectPath.replace(/^\//, "")}`;
  const params = new URLSearchParams({
    "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
    "X-Goog-Credential": `${auth.clientEmail}/${scope2}`,
    "X-Goog-Date": timestamp,
    "X-Goog-Expires": String(expiresSeconds),
    "X-Goog-SignedHeaders": "host"
  });
  params.sort();
  const canonical = canonicalRequest(
    method,
    path2,
    params.toString(),
    { host },
    "UNSIGNED-PAYLOAD"
  );
  const stringToSign = [
    "GOOG4-RSA-SHA256",
    timestamp,
    scope2,
    await sha256hex(canonical)
  ].join("\n");
  const key = await importRsaPkcs8(auth.privateKey);
  const signature2 = toHex(await rsaSha256(key, stringToSign));
  params.set("X-Goog-Signature", signature2);
  return `https://${host}${path2}?${params}`;
}

// src/gcs/File.ts
var GCSFile = class extends BaseFile {
  #apiUrl(path2 = this.path) {
    return `${this.ctx.url}/storage/v1/b/${this.ctx.bucket}/o/${encodeURIComponent(path2)}`;
  }
  #uploadUrl(query) {
    return `${this.ctx.url}/upload/storage/v1/b/${this.ctx.bucket}/o?${query}`;
  }
  async fetch(opts) {
    const rh = this.range && rangeHeader(this.range);
    return this.ctx.http.get(`${this.#apiUrl()}?alt=media`, {
      headers: rh ? { Range: rh } : {},
      signal: opts?.signal,
      what: "GET"
    });
  }
  async info(opts) {
    throwIfAborted(opts?.signal);
    const res = await this.ctx.http.get(this.#apiUrl(), {
      signal: opts?.signal,
      ok: [404],
      what: "info"
    });
    if (res.status === 404) return null;
    const meta = await res.json();
    return {
      size: rangeSize(this.range, parseInt(meta.size, 10)),
      type: meta.contentType,
      modified: new Date(meta.updated),
      version: meta.generation ?? null,
      metadata: meta.metadata ?? {},
      ...metaExtras(meta.cacheControl, meta.contentDisposition)
    };
  }
  // The JSON metadata GCS wants on a multipart or resumable upload.
  #meta(options) {
    const meta = this.meta(options);
    const out = { name: this.path };
    if (meta.type) out.contentType = meta.type;
    if (meta.cacheControl) out.cacheControl = meta.cacheControl;
    if (meta.disposition) out.contentDisposition = meta.disposition;
    if (Object.keys(meta.metadata).length) out.metadata = meta.metadata;
    return out;
  }
  async put(data, options) {
    const { type, cacheControl, disposition, metadata } = this.meta(options);
    const hasMeta = cacheControl || disposition || Object.keys(metadata).length > 0;
    if (!hasMeta) {
      await this.ctx.http.post(
        this.#uploadUrl(
          `uploadType=media&name=${encodeURIComponent(this.path)}`
        ),
        {
          headers: type ? { "Content-Type": type } : {},
          body: data,
          signal: options.signal,
          what: "PUT"
        }
      );
      return;
    }
    const boundary = `_b_${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r
Content-Type: application/json; charset=UTF-8\r
\r
${JSON.stringify(this.#meta(options))}\r
--${boundary}\r
Content-Type: ${type ?? "application/octet-stream"}\r
\r
`
      ),
      data,
      Buffer.from(`\r
--${boundary}--`)
    ]);
    await this.ctx.http.post(this.#uploadUrl("uploadType=multipart"), {
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
      signal: options.signal,
      what: "PUT"
    });
  }
  // GCS resumable upload: open a session (the URI is a capability, no auth
  // needed on the chunks), then PUT sequential ranges. The final chunk
  // carries the total size in Content-Range, which completes the object, so
  // finish() is a no-op. Chunks must be 256 KiB multiples; 8 MiB is.
  target(options) {
    return {
      partSize: 8 * 1024 * 1024,
      single: (data) => this.put(data, options),
      start: async () => {
        const res = await this.ctx.http.post(
          this.#uploadUrl(
            `uploadType=resumable&name=${encodeURIComponent(this.path)}`
          ),
          {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(this.#meta(options)),
            signal: options.signal,
            what: "resumable start"
          }
        );
        await res.text();
        const uri = res.headers.get("location");
        if (!uri)
          throw new BucketError("GCS resumable start: no session URI", {
            provider: "GCS"
          });
        return { uri, offset: 0 };
      },
      part: async (ctx, n, data, isLast) => {
        const to = ctx.offset + data.length - 1;
        const total = isLast ? String(ctx.offset + data.length) : "*";
        const res = await this.ctx.http.put(ctx.uri, {
          headers: { "Content-Range": `bytes ${ctx.offset}-${to}/${total}` },
          body: data,
          signal: options.signal,
          ok: [308],
          what: "resumable part"
        });
        await res.text();
        ctx.offset += data.length;
        return n;
      },
      finish: async () => {
      },
      abort: async (ctx) => {
        await fetch(ctx.uri, { method: "DELETE" }).catch(() => {
        });
      }
    };
  }
  async copy(key, opts) {
    await this.ctx.http.post(
      `${this.#apiUrl()}/copyTo/b/${this.ctx.bucket}/o/${encodeURIComponent(key)}`,
      { signal: opts?.signal, what: "COPY" }
    );
  }
  async delete(opts) {
    await this.ctx.http.delete(this.#apiUrl(), {
      signal: opts?.signal,
      ok: [404, 204],
      what: "DELETE"
    });
  }
  async canonicalUrl() {
    return publicUrlFrom(`${this.ctx.url}/${this.ctx.bucket}`, this.path);
  }
  async #presign(method, opts) {
    const auth = await this.ctx.auth;
    if (!auth) return null;
    return presignGCS(
      this.ctx.bucket,
      this.path,
      auth,
      method,
      expiresIn(opts)
    );
  }
  signedUrl(opts) {
    return this.#presign("GET", opts);
  }
  uploadUrl(opts) {
    return this.#presign("PUT", opts);
  }
};

// src/gcs/index.ts
var {
  GCS_BUCKET: ENV_BUCKET3,
  GCS_URL: ENV_URL2,
  GCS_ANONYMOUS: ENV_ANONYMOUS,
  GCS_PUBLIC_URL: ENV_PUBLIC_URL4
} = process.env;
function resolveConfig(bucket, config) {
  return {
    bucket,
    url: origin(config.url || ENV_URL2 || "https://storage.googleapis.com"),
    anonymous: config.anonymous ?? ENV_ANONYMOUS === "true",
    publicUrl: origin(config.publicUrl ?? ENV_PUBLIC_URL4)
  };
}
async function loadAuth() {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath) {
    if (!fs)
      throw new BucketError(
        "GOOGLE_APPLICATION_CREDENTIALS needs Node's fs module to read the file",
        { code: "INVALID_CONFIG" }
      );
    const json = JSON.parse(fs.readFileSync(credPath, "utf-8"));
    return {
      clientEmail: json.client_email ?? "",
      privateKey: json.private_key?.replace(/\\n/g, "\n")
    };
  }
  const clientEmail = process.env.GCS_CLIENT_EMAIL;
  const privateKey = process.env.GCS_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (clientEmail && privateKey) return { clientEmail, privateKey };
  return null;
}
function gcsContext(config) {
  const auth = loadAuth();
  const token = new TokenCache(async () => {
    const resolved = await auth;
    const value = resolved ? await getAccessToken(resolved) : await getMetadataToken();
    return [value, Date.now() + 55 * 60 * 1e3];
  });
  return {
    provider: "GCS",
    prefix: "",
    publicUrl: config.publicUrl,
    bucket: config.bucket,
    auth,
    anonymous: config.anonymous,
    url: config.url,
    http: new Http({
      provider: "GCS",
      authorize: async (req) => {
        if (config.anonymous) return req;
        return {
          ...req,
          headers: {
            Authorization: `Bearer ${await token.get()}`,
            ...req.headers
          }
        };
      }
    })
  };
}
var GCSBucket = class extends BaseBucket {
  type = "GCS";
  make(key) {
    return new GCSFile(key, this.ctx);
  }
  async info(opts) {
    throwIfAborted(opts?.signal);
    const { bucket, url } = this.ctx;
    return {
      type: this.type,
      name: bucket,
      url: `${url}/${bucket}`,
      id: bucket
    };
  }
  async *pages(filter, opts) {
    let pageToken;
    const s = scope(this.PREFIX, filter);
    do {
      const params = new URLSearchParams({ maxResults: "1000" });
      if (s.query) params.set("prefix", s.query);
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this.ctx.http.get(
        `${this.ctx.url}/storage/v1/b/${this.ctx.bucket}/o?${params}`,
        { signal: opts?.signal, what: "list" }
      );
      const data = await res.json();
      yield (data.items ?? []).filter((item) => s.test(item.name)).map((item) => this.make(item.name));
      pageToken = data.nextPageToken;
    } while (pageToken);
  }
};
function GCS(bucket = ENV_BUCKET3 || "", config = {}) {
  const resolved = resolveConfig(bucket, config);
  const ctx = gcsContext(resolved);
  return new GCSBucket(ctx);
}

// src/lib/signAzure.ts
var plainDate = () => (/* @__PURE__ */ new Date()).toUTCString();
var accountPathPrefix = (endpoint) => new URL(endpoint).pathname.replace(/\/$/, "");
function canonicalHeaders(headers) {
  return Object.entries(headers).filter(([k]) => k.toLowerCase().startsWith("x-ms-")).sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase())).map(([k, v]) => `${k.toLowerCase()}:${v.trim()}`).join("\n");
}
function canonicalResource(account, path2, params = {}) {
  const base = `/${account}${path2.startsWith("/") ? path2 : "/" + path2}`;
  const sorted = Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `
${k}:${v}`).join("");
  return base + sorted;
}
async function signAzure(method, path2, headers, auth, params = {}) {
  const date = plainDate();
  const allHeaders = {
    ...headers,
    "x-ms-date": date,
    "x-ms-version": "2020-10-02"
  };
  const contentLength = allHeaders["Content-Length"] ?? "";
  const contentType = allHeaders["Content-Type"] ?? "";
  const stringToSign = [
    method.toUpperCase(),
    "",
    // Content-Encoding
    "",
    // Content-Language
    contentLength === "0" ? "" : contentLength,
    "",
    // Content-MD5
    contentType,
    "",
    // Date (use x-ms-date instead)
    "",
    // If-Modified-Since
    "",
    // If-Match
    "",
    // If-None-Match
    "",
    // If-Unmodified-Since
    "",
    // Range
    canonicalHeaders(allHeaders),
    canonicalResource(auth.account, path2, params)
  ].join("\n");
  const signature2 = toBase64(
    await hmacSha256(base64ToBytes(auth.key), stringToSign)
  );
  return {
    ...allHeaders,
    Authorization: `SharedKey ${auth.account}:${signature2}`
  };
}
async function presignAzure(account, container, blobPath, key, method, expiresSeconds) {
  const now = /* @__PURE__ */ new Date();
  const expiry = new Date(now.getTime() + expiresSeconds * 1e3);
  const format = (d) => d.toISOString().replace(/\.\d+Z$/, "Z");
  const start = format(now);
  const end = format(expiry);
  const permissions = method === "w" ? "w" : "r";
  const canonicalizedResource = `/blob/${account}/${container}/${blobPath.replace(/^\//, "")}`;
  const stringToSign = [
    permissions,
    start,
    end,
    canonicalizedResource,
    "",
    // identifier
    "",
    // ip
    "https",
    "2020-10-02",
    "b",
    // signedResource: blob
    "",
    // snapshot
    "",
    // encryptionScope
    "",
    // rscc
    "",
    // rscd
    "",
    // rsce
    "",
    // rscl
    ""
    // rsct
  ].join("\n");
  const signature2 = toBase64(
    await hmacSha256(base64ToBytes(key), stringToSign)
  );
  const params = new URLSearchParams({
    sv: "2020-10-02",
    st: start,
    se: end,
    sr: "b",
    sp: permissions,
    spr: "https",
    sig: signature2
  });
  return `https://${account}.blob.core.windows.net/${container}/${blobPath.replace(/^\//, "")}?${params}`;
}

// src/azure/File.ts
var encodePath = (path2) => path2.replace(
  /[<>]/g,
  (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
);
var AzureFile = class extends BaseFile {
  #blobUrl(path2 = this.path) {
    return `${this.ctx.url}/${this.ctx.container}/${encodePath(path2)}`;
  }
  #url(path2 = this.path, params) {
    const base = this.#blobUrl(path2);
    return params ? `${base}?${new URLSearchParams(params)}` : base;
  }
  async fetch(opts) {
    const rh = this.range && rangeHeader(this.range);
    return this.ctx.http.get(this.#url(), {
      headers: rh ? { "x-ms-range": rh } : {},
      signal: opts?.signal,
      what: "GET"
    });
  }
  async info(opts) {
    throwIfAborted(opts?.signal);
    const res = await this.ctx.http.head(this.#url(), {
      signal: opts?.signal,
      ok: [404],
      what: "HEAD"
    });
    if (res.status === 404) return null;
    return {
      size: rangeSize(
        this.range,
        parseInt(res.headers.get("content-length") ?? "0", 10)
      ),
      type: res.headers.get("content-type"),
      modified: new Date(res.headers.get("last-modified") ?? Date.now()),
      version: res.headers.get("x-ms-version-id"),
      metadata: metaFromHeaders(res.headers, "x-ms-meta-"),
      ...metaExtras(
        res.headers.get("cache-control"),
        res.headers.get("content-disposition")
      )
    };
  }
  #blobHeaders(options) {
    return metaHeaders(this.meta(options), {
      type: "x-ms-blob-content-type",
      cacheControl: "x-ms-blob-cache-control",
      disposition: "x-ms-blob-content-disposition",
      metaPrefix: "x-ms-meta-"
    });
  }
  async put(data, options) {
    await this.ctx.http.put(this.#url(), {
      headers: { "x-ms-blob-type": "BlockBlob", ...this.#blobHeaders(options) },
      body: data,
      signal: options.signal,
      what: "PUT"
    });
  }
  // Azure block upload: Put Block × n, then Put Block List to commit. There
  // is no server-side session to open or abort; uncommitted blocks are
  // garbage-collected by Azure after about a week.
  target(options) {
    const blockId = (n) => Buffer.from(String(n).padStart(6, "0")).toString("base64");
    return {
      partSize: 8 * 1024 * 1024,
      single: (data) => this.put(data, options),
      start: async () => [],
      part: async (ids, n, data) => {
        const id = blockId(n);
        const res = await this.ctx.http.put(
          this.#url(this.path, { comp: "block", blockid: id }),
          { body: data, signal: options.signal, what: "block" }
        );
        await res.text();
        ids.push(id);
        return id;
      },
      finish: async (ids) => {
        const res = await this.ctx.http.put(
          this.#url(this.path, { comp: "blocklist" }),
          {
            headers: this.#blobHeaders(options),
            body: `<?xml version="1.0" encoding="utf-8"?><BlockList>` + ids.map((id) => `<Latest>${id}</Latest>`).join("") + `</BlockList>`,
            signal: options.signal,
            what: "block commit"
          }
        );
        await res.text();
      },
      abort: async () => {
      }
    };
  }
  async copy(key, opts) {
    await this.ctx.http.put(this.#url(key), {
      headers: { "x-ms-copy-source": this.#blobUrl() },
      signal: opts?.signal,
      what: "COPY"
    });
  }
  async delete(opts) {
    await this.ctx.http.delete(this.#url(), {
      headers: { "x-ms-delete-snapshots": "include" },
      signal: opts?.signal,
      ok: [404, 202],
      what: "DELETE"
    });
  }
  async canonicalUrl() {
    return this.#blobUrl();
  }
  async #presign(perm, opts) {
    const auth = this.ctx.auth;
    if (auth.type === "managed-identity") return null;
    return presignAzure(
      this.ctx.account,
      this.ctx.container,
      this.path,
      auth.key,
      perm,
      expiresIn(opts)
    );
  }
  signedUrl(opts) {
    return this.#presign("r", opts);
  }
  uploadUrl(opts) {
    return this.#presign("w", opts);
  }
};

// src/azure/index.ts
var {
  AZURE_ACCOUNT: ENV_ACCOUNT2,
  AZURE_CONTAINER: ENV_CONTAINER,
  AZURE_KEY: ENV_KEY3,
  AZURE_URL: ENV_URL3,
  AZURE_PUBLIC_URL: ENV_PUBLIC_URL5,
  AZURE_CONNECTION_STRING: ENV_CONNECTION_STRING
} = process.env;
function accountFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.replace(/^\/+|\/+$/g, "").split("/")[0];
    return seg || u.hostname.split(".")[0] || "";
  } catch {
    return "";
  }
}
function parseConnectionString(cs) {
  const map = {};
  for (const part of cs.split(";")) {
    const idx = part.indexOf("=");
    if (idx !== -1) map[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return {
    account: map["AccountName"] ?? "",
    key: map["AccountKey"] ?? "",
    // Honoured by emulators (Azurite) and custom/sovereign clouds. When present
    // it already includes the account path, e.g. http://127.0.0.1:10000/devstoreaccount1
    url: map["BlobEndpoint"]
  };
}
function resolveConfig2(container, config) {
  const cs = config.connectionString ?? ENV_CONNECTION_STRING;
  const parsed = cs ? parseConnectionString(cs) : null;
  if (parsed && config.account && config.account !== parsed.account)
    invalidConfig(
      `Azure account "${config.account}" does not match the AccountName "${parsed.account}" in the connection string`
    );
  const account = parsed ? parsed.account : config.account ?? ENV_ACCOUNT2 ?? "";
  const key = parsed ? parsed.key : config.key ?? ENV_KEY3 ?? "";
  const url = origin(
    parsed ? config.url || parsed.url : config.url ?? ENV_URL3
  );
  if (url && account) {
    const derived = accountFromUrl(url);
    if (derived && derived !== account)
      invalidConfig(
        `Azure account "${account}" does not match the account in url "${url}"`
      );
  }
  return {
    account,
    container,
    key,
    url,
    publicUrl: origin(config.publicUrl ?? ENV_PUBLIC_URL5)
  };
}
async function fetchIdentityToken() {
  const res = await fetch(
    "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://storage.azure.com/",
    { headers: { Metadata: "true" } }
  );
  if (!res.ok)
    throw new BucketError("Azure Managed Identity token fetch failed", {
      provider: "Azure",
      status: res.status,
      code: "UNAUTHORIZED"
    });
  const data = await res.json();
  const expiry = Date.now() + (parseInt(data.expires_in) - 60) * 1e3;
  return [data.access_token, expiry];
}
function azureContext(config) {
  const { account, container, key, publicUrl } = config;
  const token = new TokenCache(fetchIdentityToken);
  const auth = key ? { type: "shared-key", key } : { type: "managed-identity", getToken: () => token.get() };
  const host = config.url || `https://${account}.blob.core.windows.net`;
  return {
    provider: "Azure",
    prefix: "",
    publicUrl,
    account,
    container,
    url: host,
    auth,
    http: new Http({
      provider: "Azure",
      authorize: async (req) => {
        const u = new URL(req.url);
        const params = Object.fromEntries(u.searchParams);
        const headers = {
          ...req.headers,
          ...req.body !== void 0 ? { "Content-Length": String(Buffer.byteLength(req.body)) } : {}
        };
        if (auth.type === "shared-key") {
          const path2 = u.pathname.replace(accountPathPrefix(host), "");
          return {
            ...req,
            headers: await signAzure(
              req.method,
              `${accountPathPrefix(host)}${path2}`,
              headers,
              { account, key: auth.key },
              Object.keys(params).length ? params : void 0
            )
          };
        }
        return {
          ...req,
          headers: {
            ...headers,
            "x-ms-date": (/* @__PURE__ */ new Date()).toUTCString(),
            "x-ms-version": "2020-10-02",
            Authorization: `Bearer ${await token.get()}`
          }
        };
      }
    })
  };
}
var AzureBucket = class extends BaseBucket {
  type = "AZURE";
  make(key) {
    return new AzureFile(key, this.ctx);
  }
  async info(opts) {
    throwIfAborted(opts?.signal);
    const { account, container, url } = this.ctx;
    return {
      type: this.type,
      name: container,
      url: `${url}/${container}`,
      id: account
    };
  }
  async *pages(filter, opts) {
    let marker;
    const s = scope(this.PREFIX, filter);
    const { container, url } = this.ctx;
    do {
      const params = {
        restype: "container",
        comp: "list",
        ...s.query ? { prefix: s.query } : {},
        ...marker ? { marker } : {}
      };
      const res = await this.ctx.http.get(
        `${url}/${container}?${new URLSearchParams(params)}`,
        { signal: opts?.signal, what: "list" }
      );
      const xml = await res.text();
      yield extractTags(xml, "Blob").map((item) => unescapeXml(getTag(item, "Name"))).filter((name) => s.test(name)).map((name) => this.make(name));
      marker = getTag(xml, "NextMarker") || void 0;
    } while (marker);
  }
};
function Azure(container = ENV_CONTAINER || "", config = {}) {
  const resolved = resolveConfig2(container, config);
  const ctx = azureContext(resolved);
  return new AzureBucket(ctx);
}

// src/b2/session.ts
var API_VERSION_URL = "/b2api/v2/";
var authError = (message, status) => {
  throw new BucketError(message, { provider: "BACKBLAZE", status });
};
async function authorize(id, secret, name, knownBucketId = "") {
  const derived = Buffer.from(id + ":" + secret).toString("base64");
  const res = await fetch(
    "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
    { headers: { Authorization: "Basic " + derived } }
  );
  if (!res.ok) authError(`B2 authorize error: ${res.status}`, res.status);
  const data = await res.json();
  const apiBase = data.apiUrl + API_VERSION_URL;
  const auth = {
    token: data.authorizationToken,
    apiBase,
    base: data.downloadUrl.replace(/\/$/, "") + "/",
    absoluteMinimumPartSize: data.absoluteMinimumPartSize ?? 5 * 1024 * 1024
  };
  const allowedId = data.allowed?.bucketId ?? "";
  const allowedName = data.allowed?.bucketName ?? "";
  if (allowedId) {
    if (name && allowedName && name !== allowedName)
      authError(
        `B2 key is restricted to the bucket "${allowedName}", so it cannot be used for "${name}"`
      );
    return { ...auth, bucketId: allowedId, bucketName: allowedName || name };
  }
  if (knownBucketId)
    return { ...auth, bucketId: knownBucketId, bucketName: name };
  if (!name)
    authError(
      "B2 needs a bucket name: this key is not restricted to a single bucket, so pass one to BackBlaze() or set B2_BUCKET"
    );
  if (data.allowed?.capabilities?.includes("listBuckets") === false)
    authError(
      `B2 cannot resolve the bucket "${name}": this key is not restricted to a bucket and lacks the "listBuckets" capability. Use a bucket-restricted key, or grant it listBuckets.`
    );
  const url = apiBase + "b2_list_buckets?accountId=" + encodeURIComponent(data.accountId) + "&bucketName=" + encodeURIComponent(name);
  const listRes = await fetch(url, { headers: { Authorization: auth.token } });
  if (!listRes.ok)
    authError(
      `B2 cannot resolve the bucket "${name}": list buckets failed with ${listRes.status}`,
      listRes.status
    );
  const { buckets } = await listRes.json();
  const found = buckets?.find((b) => b.bucketName === name);
  if (!found)
    authError(
      `B2 bucket "${name}" does not exist, or this key cannot access it`
    );
  return { ...auth, bucketId: found.bucketId, bucketName: name };
}
var B2Session = class {
  #id;
  #secret;
  #name;
  #auth;
  // The token currently in use; "" while a refresh is in flight.
  #token = "";
  constructor(id, secret, name) {
    this.#id = id;
    this.#secret = secret;
    this.#name = name;
    this.#auth = this.#adopt(authorize(id, secret, name));
  }
  #adopt(auth) {
    auth.then(
      (a) => {
        this.#token = a.token;
      },
      () => {
      }
    );
    return auth;
  }
  get() {
    return this.#auth;
  }
  /** Re-authorizes because `token` was rejected as expired. Only the first
   * caller with the current token re-authorizes; every other one, and any
   * later caller still holding an old token, awaits that same replacement. */
  async refresh(token) {
    if (token && token === this.#token) {
      this.#token = "";
      const stale = this.#auth;
      this.#auth = this.#adopt(
        stale.then(
          (a) => authorize(this.#id, this.#secret, a.bucketName, a.bucketId)
        ).catch(() => authorize(this.#id, this.#secret, this.#name))
      );
    }
    await this.#auth;
  }
};

// src/b2/File.ts
var B2File = class extends BaseFile {
  // The download-by-name URL, only known once the account has authorized.
  async #downloadUrl() {
    const auth = await this.ctx.session.get();
    return auth.base + "file/" + auth.bucketName + "/" + this.path;
  }
  // A JSON API call; `name` is the B2 operation, e.g. "b2_hide_file".
  async #api(name, body, options = {}) {
    const auth = await this.ctx.session.get();
    return this.ctx.http.post(auth.apiBase + name, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      what: name,
      ...options
    });
  }
  // Asks for an upload URL, which comes with its own single-use token.
  async #uploadAuth(query, signal) {
    const auth = await this.ctx.session.get();
    const res = await this.ctx.http.get(auth.apiBase + query, {
      signal,
      what: "upload url"
    });
    return await res.json();
  }
  // The upload URL's token replaces the account token, so the request goes
  // out as-is: a 401 there means a stale upload URL, not an expired account.
  async #upload(auth, data, headers, signal) {
    const res = await this.ctx.http.post(auth.uploadUrl, {
      auth: false,
      body: data,
      headers: {
        Authorization: auth.authorizationToken,
        "X-Bz-Content-Sha1": await sha1hex(data),
        "Content-Length": String(data.length),
        ...headers
      },
      signal,
      what: "upload"
    });
    await res.json();
  }
  async fetch(opts) {
    const rh = this.range && rangeHeader(this.range);
    return this.ctx.http.get(await this.#downloadUrl(), {
      headers: rh ? { Range: rh } : {},
      signal: opts?.signal,
      what: "GET"
    });
  }
  async info(opts) {
    throwIfAborted(opts?.signal);
    const res = await this.ctx.http.head(await this.#downloadUrl(), {
      signal: opts?.signal,
      ok: [404],
      what: "HEAD"
    });
    if (res.status === 404) return null;
    const ts = res.headers.get("x-bz-upload-timestamp");
    return {
      size: rangeSize(
        this.range,
        Number(res.headers.get("content-length") ?? 0)
      ),
      type: res.headers.get("content-type"),
      modified: ts ? new Date(Number(ts)) : /* @__PURE__ */ new Date(),
      version: res.headers.get("x-bz-file-id"),
      metadata: metaFromHeaders(
        res.headers,
        "x-bz-info-",
        (k) => k.startsWith("b2-")
      ),
      ...metaExtras(
        res.headers.get("x-bz-info-b2-cache-control"),
        res.headers.get("x-bz-info-b2-content-disposition")
      )
    };
  }
  // Detect from the extension like every other provider; fall back to B2's
  // server-side auto-detection ("b2/x-auto") only for unknown extensions.
  #type(options) {
    return this.meta(options).type ?? "b2/x-auto";
  }
  #fileInfo(options) {
    return metaHeaders(this.meta(options), {
      cacheControl: "b2-cache-control",
      disposition: "b2-content-disposition",
      metaPrefix: ""
    });
  }
  async put(data, options) {
    const auth = await this.ctx.session.get();
    const upload = await this.#uploadAuth(
      "b2_get_upload_url?bucketId=" + auth.bucketId,
      options.signal
    );
    const headers = {
      "X-Bz-File-Name": this.path,
      "Content-Type": this.#type(options)
    };
    for (const [k, v] of Object.entries(this.#fileInfo(options)))
      headers[`X-Bz-Info-${k}`] = v;
    await this.#upload(upload, data, headers, options.signal);
  }
  // B2 large-file upload: b2_start_large_file → b2_upload_part × n →
  // b2_finish_large_file, cancelling on failure so no orphan parts remain.
  target(options) {
    return {
      // B2's recommendedPartSize is ~100 MB, far too much to buffer per part,
      // so use our own 8 MiB and only defer to B2 when its minimum is higher.
      partSize: async () => {
        const auth = await this.ctx.session.get();
        return Math.max(auth.absoluteMinimumPartSize, 8 * 1024 * 1024);
      },
      single: (data) => this.put(data, options),
      start: async () => {
        const auth = await this.ctx.session.get();
        const res = await this.#api(
          "b2_start_large_file",
          {
            bucketId: auth.bucketId,
            fileName: this.path,
            contentType: this.#type(options),
            fileInfo: this.#fileInfo(options)
          },
          { signal: options.signal }
        );
        return await res.json();
      },
      part: async (ctx, n, data) => {
        const upload = await this.#uploadAuth(
          "b2_get_upload_part_url?fileId=" + ctx.fileId,
          options.signal
        );
        const sha1 = await sha1hex(data);
        await this.#upload(
          upload,
          data,
          { "X-Bz-Part-Number": String(n) },
          options.signal
        );
        return sha1;
      },
      finish: async (ctx, parts) => {
        const res = await this.#api(
          "b2_finish_large_file",
          { fileId: ctx.fileId, partSha1Array: parts },
          { signal: options.signal }
        );
        await res.json();
      },
      abort: async (ctx) => {
        const res = await this.#api("b2_cancel_large_file", {
          fileId: ctx.fileId
        });
        await res.json();
      }
    };
  }
  // B2 has no server-side copy: stream the bytes through.
  async copy(key, opts) {
    await this.at(key).write(this, opts);
  }
  async delete(opts) {
    const auth = await this.ctx.session.get();
    const res = await this.#api(
      "b2_hide_file",
      { bucketId: auth.bucketId, fileName: this.path },
      { signal: opts?.signal, raw: true }
    );
    if (!res.ok) {
      const { code } = await res.json().catch(() => ({}));
      if (!/file_not_present|no_such_file/.test(code ?? ""))
        this.check(res, "b2_hide_file");
    }
  }
  async canonicalUrl() {
    const auth = await this.ctx.session.get();
    return publicUrlFrom(`${auth.base}file/${auth.bucketName}`, this.path);
  }
  async signedUrl(opts) {
    const auth = await this.ctx.session.get();
    const res = await this.#api("b2_get_download_authorization", {
      bucketId: auth.bucketId,
      fileNamePrefix: this.path,
      validDurationInSeconds: Math.ceil(expiresIn(opts))
    });
    const { authorizationToken } = await res.json();
    return `${await this.#downloadUrl()}?Authorization=${encodeURIComponent(authorizationToken)}`;
  }
  // B2 uploads need auth headers, so a standalone upload URL cannot exist.
  async uploadUrl(_opts) {
    return null;
  }
};

// src/b2/index.ts
var {
  B2_BUCKET: ENV_NAME,
  B2_APPLICATION_KEY_ID: ENV_ID3,
  B2_APPLICATION_KEY: ENV_KEY4,
  B2_PUBLIC_URL: ENV_PUBLIC_URL6
} = process.env;
function b2Context(session, publicUrl) {
  return {
    provider: "BACKBLAZE",
    prefix: "",
    publicUrl,
    session,
    http: new Http({
      provider: "BACKBLAZE",
      authorize: async (req) => ({
        ...req,
        headers: { Authorization: (await session.get()).token, ...req.headers }
      }),
      // A 401 on a 24h-old token just means it expired. Upload URLs carry a
      // separate token and are sent with `auth: false`, so they never land here.
      refresh: (req) => session.refresh(req.headers.Authorization)
    })
  };
}
var BackBlazeInstance = class extends BaseBucket {
  type = "BACKBLAZE";
  make(key) {
    return new B2File(key, this.ctx);
  }
  async info(opts) {
    throwIfAborted(opts?.signal);
    const auth = await this.ctx.session.get();
    return {
      type: this.type,
      name: auth.bucketName,
      url: auth.base,
      id: auth.bucketId
    };
  }
  async *pages(filter, opts) {
    const auth = await this.ctx.session.get();
    let nextFileName;
    const s = scope(this.PREFIX, filter);
    do {
      let url = auth.apiBase + "b2_list_file_names?bucketId=" + encodeURIComponent(auth.bucketId);
      if (s.query) url += "&prefix=" + encodeURIComponent(s.query);
      if (nextFileName)
        url += "&startFileName=" + encodeURIComponent(nextFileName);
      const res = await this.ctx.http.get(url, {
        signal: opts?.signal,
        what: "list"
      });
      const data = await res.json();
      yield data.files.filter((f) => s.test(f.fileName)).map((f) => this.make(f.fileName));
      nextFileName = data.nextFileName;
    } while (nextFileName);
  }
};
function BackBlaze(name = ENV_NAME || "", {
  id = ENV_ID3 || "",
  secret = ENV_KEY4 || "",
  publicUrl = ENV_PUBLIC_URL6 || ""
} = {}) {
  const session = new B2Session(id, secret, name);
  const ctx = b2Context(session, origin(publicUrl));
  return new BackBlazeInstance(ctx);
}

// src/memory/File.ts
var MemoryFile = class extends BaseFile {
  #entry() {
    const entry = this.ctx.files.get(this.path);
    if (!entry) {
      throw new BucketError(`Memory file not found: ${this.path}`, {
        provider: this.provider,
        code: "NOT_FOUND"
      });
    }
    return entry;
  }
  // Wraps the bytes (the slice, when one is set) as a Response so the shared
  // readers work unchanged, carrying the stored content type.
  async fetch() {
    const entry = this.#entry();
    const data = this.range ? entry.data.subarray(this.range.start, this.range.end) : entry.data;
    return new Response(new Uint8Array(data), {
      headers: entry.type ? { "content-type": entry.type } : {}
    });
  }
  async info(opts) {
    throwIfAborted(opts?.signal);
    const entry = this.ctx.files.get(this.path);
    if (!entry) return null;
    return {
      size: rangeSize(this.range, entry.data.length),
      type: entry.type,
      modified: entry.modified,
      // Nothing is versioned here: remove() deletes.
      version: null,
      metadata: { ...entry.metadata },
      ...entry.cacheControl ? { cacheControl: entry.cacheControl } : {},
      ...entry.disposition ? { disposition: entry.disposition } : {}
    };
  }
  // The single place an entry is created, so every write path records the
  // same metadata: nothing a caller passes is dropped.
  async put(data, options) {
    this.ctx.files.set(this.path, {
      data,
      modified: /* @__PURE__ */ new Date(),
      ...this.meta(options)
    });
  }
  // Committed only on close, so a reader never sees a partial write.
  target(options) {
    return wholeBody((data) => this.put(data, options));
  }
  async copy(key) {
    const entry = this.#entry();
    this.ctx.files.set(key, {
      ...entry,
      data: Buffer.from(entry.data),
      metadata: { ...entry.metadata },
      modified: /* @__PURE__ */ new Date()
    });
  }
  async delete() {
    this.ctx.files.delete(this.path);
  }
  // Nothing serves these bytes, so there is no canonical URL to fall back on.
  async canonicalUrl() {
    return null;
  }
  // Nothing to sign: there is no endpoint behind an in-memory bucket.
  async signedUrl(_opts) {
    return null;
  }
  async uploadUrl(_opts) {
    return null;
  }
};

// src/memory/index.ts
var { MEMORY_PUBLIC_URL: ENV_PUBLIC_URL7 } = process.env;
var MemoryBucket = class extends BaseBucket {
  type = "MEMORY";
  make(key) {
    return new MemoryFile(key, this.ctx);
  }
  async info(opts) {
    throwIfAborted(opts?.signal);
    const scoped = this.PREFIX ? `${this.ctx.name}/${this.PREFIX}` : this.ctx.name;
    return {
      type: this.type,
      name: scoped,
      url: `memory://${scoped}`,
      id: this.ctx.name
    };
  }
  async *pages(filter) {
    const s = scope(this.PREFIX, filter);
    yield [...this.ctx.files.keys()].filter((key) => s.test(key)).sort((a, b) => a.localeCompare(b)).map((key) => this.make(key));
  }
};
function Memory(name = "memory", config = {}) {
  if (!name) invalidConfig("Memory needs a bucket name.");
  const ctx = {
    provider: "MEMORY",
    prefix: "",
    publicUrl: origin(config.publicUrl ?? ENV_PUBLIC_URL7),
    // A folder shares this Map; a second Memory() call gets its own, which is
    // what makes instances isolated.
    files: /* @__PURE__ */ new Map(),
    name
  };
  return new MemoryBucket(ctx);
}

// src/index.ts
var index_default = { FS: FileSystem, S3, R2: CloudflareR2, GCS, Azure, B2: BackBlaze, Memory };
export {
  Azure,
  BackBlaze as B2,
  BackBlaze,
  BucketError,
  CloudflareR2,
  FileSystem as FS,
  FileSystem,
  GCS,
  Memory,
  CloudflareR2 as R2,
  S3,
  index_default as default,
  mimes_default as mimes
};
