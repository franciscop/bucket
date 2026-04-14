import hash from "hash-it";

import { userInfo } from "node:os";
import { Blob } from "node:buffer";
import { exec } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
import { WritableStream } from "node:stream/web";
import { promisify } from "node:util";

// This is better than extension-guessing
const execP = promisify(exec);
const cmd = (txt) => execP(txt).then((res) => res.stdout.trim());
const mimeType = (file) => cmd(`file -b --mime-type '${file}'`);

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

FileSystem.prototype.list = async function (filter) {
  const raw = await fsp.readdir(this.path, {
    recursive: true,
    withFileTypes: true,
  });
  const files = raw
    .filter((dirent) => dirent.isFile())
    .map((f) => this.file(join(f.path, f.name)));
  // Only the name, even if it's in a subpath
  if (filter instanceof RegExp) {
    return files.filter((f) => filter.test(f.name));
  }
  return files;
};

FileSystem.prototype.file = function (name) {
  if (!name) throw new Error("No name");
  const path = resolve(isAbsolute(name) ? name : join(this.path, name));
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
    const [exists, info, type] = await Promise.all([
      this.exists(),
      fsp.stat(this.path).catch(() => ({ size: 0 })),
      mimeType(this.path),
    ]);
    return {
      id: this.id,
      name: this.name,
      path: this.path,

      exists,
      type: exists ? type : null,
      size: info.size,
      date: exists ? new Date(info.mtime) : null,
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
    if (typeof content === "string") {
      await fsp.mkdir(dirname(this.path), { recursive: true });
      return fsp.writeFile(this.path, content);
    }
    if (content instanceof Buffer) {
      await fsp.mkdir(dirname(this.path), { recursive: true });
      return fsp.writeFile(this.path, content);
    }
    if (content instanceof Blob) {
      await fsp.mkdir(dirname(this.path), { recursive: true });
      return fsp.writeFile(
        this.path,
        Buffer.from(await content.arrayBuffer(), "binary"),
      );
    }
    if (content instanceof File) {
      return content.readable("web").pipeTo(this.writable("web"));
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
    if (type === "node") {
      return Writable.fromWeb(this.writable("web"));
    }

    const filePath = this.path;
    let writer = null;
    return new WritableStream({
      async start() {
        await fsp.mkdir(dirname(filePath), { recursive: true });
        writer = createWriteStream(filePath);
        await new Promise((resolve) => writer.on("open", resolve));
      },
      write(chunk) {
        return new Promise((resolve, reject) => {
          const ok = writer.write(chunk);
          if (ok) resolve();
          else writer.once("drain", resolve);
          writer.once("error", reject);
        });
      },
      close() {
        return new Promise((resolve, reject) => {
          writer.end((err) => (err ? reject(err) : resolve()));
        });
      },
    });
  }
}
