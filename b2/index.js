import "dotenv/config";

import hash from "hash-it";
import { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import promiseToReadable from "../lib/promiseToReadable.js";
import promiseToWritable from "../lib/promiseToWritable.js";

const hashString = (str) => {
  return createHash("sha1").update(str).digest("hex");
};

const API_VERSION_URL = "/b2api/v2/";

const {
  BACKBLAZE_NAME: NAME,
  BACKBLAZE_ID: ID,
  BACKBLAZE_KEY: KEY,
} = process.env;

export default function BackBlaze(name = NAME, { id = ID, key = KEY } = {}) {
  if (!(this instanceof BackBlaze)) {
    return new BackBlaze(name, { id, key });
  }
  this.promise = (async (done) => {
    const derived = Buffer.from(id + ":" + key).toString("base64");
    const res = await this.fetch(
      "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
      { headers: { Authorization: "Basic " + derived } },
    );
    const data = await res.json();
    this.id = data.allowed.bucketId; // Bucket ID
    this.name = name;
    this.token = data.authorizationToken;
    this.api = data.apiUrl + API_VERSION_URL;
    this.base = data.downloadUrl.replace(/\/$/, "") + "/";
  })();
}

BackBlaze.prototype.type = "BACKBLAZE";

BackBlaze.prototype.info = async function () {
  await this.promise;
  return {
    id: this.id,
    name: this.name,
    type: this.type,
    base: this.base,
  };
};

BackBlaze.prototype.fetch = async function (url, options = {}) {
  await this.promise;
  const headers = { Authorization: this.token };
  const res = await fetch(url, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  if (!res.ok) {
    const path = url.split(".com").pop();
    if (res.headers.get("content-type").includes("application/json")) {
      const { status, code, message } = await res.json();
      throw new Error(`[${status}] "${code}" on ${path}\n${message}`);
    } else {
      throw new Error(`Error ${res.status}: ${path}\n${await res.text()}`);
    }
  }
  return res;
};

BackBlaze.prototype.file = function (name) {
  if (!name) throw new Error("No name");
  return new File(name, this);
};

BackBlaze.prototype.list = async function (prefix = "") {
  await this.promise;
  let url =
    this.api + "b2_list_file_names?bucketId=" + encodeURIComponent(this.id);
  if (prefix && typeof prefix === "string")
    url += "&prefix=" + encodeURIComponent(prefix);
  const res = await this.fetch(url);
  const data = await res.json();
  return data.files
    .filter((f) => (prefix instanceof RegExp ? prefix.test(f.fileName) : true))
    .map((file) => {
      const f = new File(file.fileName, this);
      f.id = file.fileId;
      f.type = file.contentType;
      f.size = file.contentLength;
      f.date = new Date(file.uploadTimestamp);
      f.url = this.base + "file/" + this.name + "/" + file.fileName;
      return f;
    });
};

class File {
  #bucket;

  constructor(path, bucket) {
    if (!(this instanceof File)) {
      return new File(path);
    }
    // Basic file info
    this.id = hash(path);
    this.name = path.split("/").pop();
    this.path = path;
    this.#bucket = bucket;
  }

  async info() {
    const files = await this.#bucket.list(this.path);
    if (files.length) {
      this.id = files[0].id;
      this.type = files[0].contentType;
      this.size = files[0].contentLength;
      this.date = new Date(files[0].uploadTimestamp);
      return {
        ...files[0],
        exists: true,
      };
    }
    return {
      id: this.id,
      name: this.name,
      path: this.path,
      exists: false,
      type: null,
      size: 0,
      date: null,
      url: null,
    };
  }

  async text() {
    const bucket = await this.#bucket.info();
    const url = bucket.base + "file/" + bucket.name + "/" + this.path;
    const res = await this.#bucket.fetch(url);
    return await res.text();
  }

  async json() {
    const bucket = await this.#bucket.info();
    const url = bucket.base + "file/" + bucket.name + "/" + this.path;
    const res = await this.#bucket.fetch(url);
    return await res.json();
  }

  async buffer() {
    const bucket = await this.#bucket.info();
    const url = bucket.base + "file/" + bucket.name + "/" + this.path;
    const res = await this.#bucket.fetch(url);
    return Buffer.from(await res.arrayBuffer());
  }

  async blob() {
    const bucket = await this.#bucket.info();
    const url = bucket.base + "file/" + bucket.name + "/" + this.path;
    const res = await this.#bucket.fetch(url);
    return res.blob();
  }

  async exists() {
    return (await this.info()).size !== 0;
  }

  async #put(data) {
    const [file, bucket] = await Promise.all([
      this.info(),
      this.#bucket.info(),
    ]);
    const url = this.#bucket.api + "b2_get_upload_url?bucketId=" + bucket.id;
    const res = await this.#bucket.fetch(url);
    const auth = await res.json();

    const headers = {
      Authorization: auth.authorizationToken,
      "X-Bz-File-Name": this.path,
      "X-Bz-Content-Sha1": hashString(data),
      "Content-Length": Buffer.byteLength(data),
      "Content-Type": "b2/x-auto",
    };
    await this.#bucket.fetch(auth.uploadUrl, {
      body: data,
      method: "POST",
      headers,
    });
  }

  async write(content) {
    if (typeof content === "string") {
      return this.#put(content);
    }
    if (content instanceof Buffer) {
      return this.#put(content);
    }
    if (content instanceof Blob) {
      return this.#put(Buffer.from(await content.arrayBuffer(), "binary"));
    }
    if (content instanceof File) {
      return this.#put(await content.buffer());
    }
    if (typeof content.pipeTo === "function") {
      return content.pipeTo(this.writable("web"));
    }
    if (content instanceof Readable) {
      return Readable.toWeb(content).pipeTo(this.writable("web"));
    }
    throw new Error("Invalid content type");
  }

  async remove() {
    const bucket = await this.#bucket.info();
    do {
      const url =
        this.#bucket.api + "b2_delete_file_version?bucketId=" + bucket.id;
      await this.#bucket.fetch(url, {
        method: "POST",
        body: JSON.stringify({ fileId: this.id, fileName: this.path }),
        headers: { "Content-Type": "application/json" },
      });
      // Keep removing it until there's no copies
    } while (await this.exists());
  }

  writable(type = "web") {
    if (type === "node") {
      return Writable.fromWeb(this.writable("web"));
    }
    return promiseToWritable((data) => this.write(data));
  }

  readable(type = "web") {
    if (type === "node") {
      return Readable.fromWeb(this.readable("web"));
    }
    return promiseToReadable(async () => {
      const bucket = await this.#bucket.info();
      const url = bucket.base + "file/" + bucket.name + "/" + this.name;
      const res = await this.#bucket.fetch(url);
      return res.body;
    });
  }
}
