import { exec } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import swear from "swear";

export const ENV_NAME = "FILESYSTEM_NAME";
export const ENV_ID = null;
export const ENV_KEY = null;

const execP = promisify(exec);
const cmd = (txt) => swear(execP(txt)).stdout;

const mimeType = (file) => cmd(`file -b --mime-type '${file}'`).trim();

const normalize = (base, prefix = ".") => {
  if (!base.startsWith("./")) {
    if (base.startsWith("/")) {
      base = "." + base;
    } else if (base === ".") {
      base = "./";
    } else {
      base = "./" + base;
    }
  }
  // Remove any ending `/`; reserve those for the prefix
  base = base.replace(/\/$/, "");

  if (!prefix.startsWith(".")) {
    if (prefix.startsWith("/")) {
      prefix = "." + prefix;
    } else if (prefix === ".") {
      prefix = "./";
    } else {
      prefix = "./" + prefix;
    }
  }
  prefix = prefix.replace(/^\./, "");
  return (base + prefix).replace("//", "/");
};

function streamToString(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", (err) => reject(err));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const absolute = (base, file) => {
  return file.replace(base, "");
};

export default function Bucket(name = ".", options) {
  name = normalize(name);

  const info = () => ({
    id: resolve(name).split("/").filter(Boolean).join(":"),
    path: resolve(name),
  });

  const list = (prefix = "./") => {
    prefix = normalize(name, prefix);

    return cmd(`find ${name} -type f`)
      .split("\n")
      .filter(Boolean)
      .filter((f) => f.startsWith(prefix))
      .map((file) => absolute(name, file))
      .map(async (file) => {
        const url = resolve(normalize(name, file));
        const [info, mime] = await Promise.all([fsp.stat(url), mimeType(url)]);
        return {
          id: file,
          name: file.split("/").pop(),
          path: file,
          type: mime,
          size: info.size,
          date: new Date(info.mtime),
          url,
        };
      });
  };

  const count = async (prefix = "/") => {
    const files = await list(prefix);
    return files.length;
  };

  const exists = (prefix) => {
    prefix = normalize(name, prefix);
    return fsp.access(prefix).then(() => true, () => false); // prettier-ignore
  };

  const upload = async (src, dst) => {
    dst = normalize(name, dst);
    await fsp.mkdir(dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
    return absolute(name, dst);
  };

  const download = async (src, dst) => {
    src = normalize(name, src);
    await fsp.mkdir(dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
    return dst;
  };

  const remove = async (file) => {
    if (!(await exists(file))) return;
    file = normalize(name, file);

    if ((await fsp.lstat(file)).isDirectory()) {
      return fsp.rmdir(file, { recursive: true });
    }

    await fsp.unlink(file);

    // Needs to be before we normalize it to our filesystem
    let folder = dirname(file);

    // Remove empty folders
    if (!(await count(absolute(name, folder)))) {
      await fsp.rmdir(folder);
    }
    return file;
  };

  const read = (src) => {
    src = normalize(name, src);

    // Absorb the error here because otherwise it triggers globally on the
    // promise if there's an error there. pipeline() adds an extra on('error')
    // so pipe handles errors properly, and .then() already has its own errors
    const stream = createReadStream(src).on("error", (err) => err);

    // Overload the stream with then and catch methods to behave like a promise
    stream.then = (...args) => {
      stream.destroy();
      return fsp.readFile(src, "utf8").then(...args);
    };
    stream.catch = (cb) => stream.then((data) => data, cb);

    // Return the composite method
    return stream;
  };

  const write = (dst, data) => {
    dst = normalize(name, dst);
    if (!data) {
      return createWriteStream(dst);
    }
    return fsp.mkdir(dirname(dst), { recursive: true }).then(() => {
      return fsp.writeFile(dst, data);
    });
  };

  const copy = async (src, dst) => {
    // TODO: copy directory or collection of files as well
    src = normalize(name, src);
    dst = normalize(name, dst);
    await fsp.mkdir(dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
  };

  const sign = () => {
    console.warn("The Bucket/fs cannot sign URLs");
    return null;
  };

  return {
    name: "Bucket/fs",
    info,
    count,
    list,
    upload,
    download,
    read,
    write,

    remove,
    exists,
    copy,
    sign,
  };
}
