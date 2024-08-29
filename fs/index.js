import "isomorphic-fetch";

import { userInfo } from "os";

import hashMod from "hash-it";

import { Blob } from "node:buffer";
import { exec } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable, PassThrough } from "node:stream";
import { promisify } from "util";

const { default: hash } = hashMod;

const execP = promisify(exec);
const cmd = (txt) => execP(txt).then((res) => res.stdout.trim());
const mimeType = (file) => cmd(`file -b --mime-type '${file}'`);

const merge = (...streams) => {
  let pass = new PassThrough();
  for (let stream of streams) {
    console.log(stream);
    const end = stream == streams.at(-1);
    pass = stream.pipe(pass, { end });
  }
  return pass;
};

const ensurePathStream = (path) => {
  const s = new PassThrough();
  s._read = () => {}; // redundant? see update below
  (async () => {
    await fsp.mkdir(dirname(path), { recursive: true });
    s.push(null);
  })();
  return s;
};

export default function FileSystem(path) {
  if (!(this instanceof FileSystem)) {
    return new FileSystem(path);
  }
  this.path = resolve(path);
}

FileSystem.prototype.name = "FILESYSTEM";

FileSystem.prototype.info = function () {
  const id = userInfo().username;
  return {
    id,
    name: this.name,
    path: this.path,
  };
};

FileSystem.prototype.file = function (name) {
  const path = resolve(join(this.path, name));
  return new File(path);
};

class File {
  constructor(path) {
    if (!(this instanceof File)) {
      return new File(path);
    }
    // Basic file info
    this.id = hash(path);
    this.name = path.split("/").pop();
    this.path = path;
  }

  async info() {
    const [info, type] = await Promise.all([
      fsp.stat(this.path),
      mimeType(this.path),
    ]);
    return {
      id: this.id,
      name: this.name,
      path: this.path,
      type,
      size: info.size,
      date: new Date(info.mtime),
      url: null,
    };
  }

  async exists() {
    return fsp
      .access(this.path, fsp.constants.F_OK)
      .then(() => true)
      .catch(() => false);
  }

  async text() {
    return fsp.readFile(this.path, "utf-8");
  }

  async json() {
    return fsp.readFile(this.path, "utf-8").then((data) => JSON.parse(data));
  }

  async buffer() {
    return fsp.readFile(this.path);
  }

  async blob() {
    const buffer = await fsp.readFile(this.path);
    return new Blob([buffer]);
  }

  async write(content) {
    await fsp.mkdir(dirname(this.path), { recursive: true });
    if (typeof content === "string") {
      return fsp.writeFile(this.path, content);
    }
    if (Buffer.isBuffer(content)) {
      return fsp.writeFile(this.path, content);
    }
    if (content instanceof File) {
      return content.readable("web").pipeTo(this.writable("web"));
    }
    if (content instanceof Blob) {
      return fsp.writeFile(
        this.path,
        Buffer.from(await content.arrayBuffer(), "binary"),
      );
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
    return fsp.unlink(this.path);
  }

  readable(type = "web") {
    if (type === "node") {
      return createReadStream(this.path);
    }
    if (type === "web") {
      return Readable.toWeb(createReadStream(this.path));
    }
  }

  writable(type = "web") {
    if (type === "web") {
      return Writable.toWeb(this.writable("node"));
    }

    if (type === "node") {
      // Create a writable that first ensures the folder exists and THEN
      // creates the write stream to write to it
      return createWriteStream(this.path);
      const path = this.path;
      let writer;
      return new Writable({
        async construct(next) {
          await fsp.mkdir(dirname(path), { recursive: true });
          writer = createWriteStream(path);
          next();
        },
        async write(chunk, encoding, next) {
          writer.encoding = encoding;
          writer.write(chunk);
          next();
        },
      });
    }
  }
}
