import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash, randomBytes } from "node:crypto";

import "dotenv/config";
import fch from "fch";
// import axios from "axios";
import swear from "swear";
import listFromGenerator from "../lib/listFromGenerator.js";

const API_VERSION_URL = "/b2api/v2/";

export const ENV_NAME = "BACKBLAZE_NAME";
export const ENV_ID = "BACKBLAZE_ID";
export const ENV_KEY = "BACKBLAZE_KEY";

const PAGE_SIZE = process.env.PAGE_SIZE || 10000;

const rand = () => randomBytes(32).toString("hex");

class CodeError extends Error {
  constructor(error) {
    super(error);
    this.code = error.code;
    this.message = error.code.toUpperCase() + " " + error.message;
    this.stack = error.stack;
  }
}

const {
  BACKBLAZE_NAME: NAME,
  BACKBLAZE_ID: ID,
  BACKBLAZE_KEY: KEY,
} = process.env;

const hashFile = (src) => {
  return new Promise((resolve, reject) => {
    const fd = createReadStream(src);
    const hp = createHash("sha1");
    hp.setEncoding("hex");
    fd.pipe(hp);
    fd.on("end", () => {
      hp.end();
      resolve(hp.read()); // the desired sha1sum
    });
    fd.on("error", (err) => {
      hp.end();
      reject(err);
    });
  });
};

const hashString = (str) => {
  return createHash("sha1").update(str).digest("hex");
};

export default function (name = NAME, { id = ID, key = KEY } = {}) {
  let baseInfo;

  let apiPromise = (async () => {
    const headerKey = Buffer.from(id + ":" + key).toString("base64");
    const headers = { Authorization: "Basic " + headerKey };
    const data = await fch(
      "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
      { headers }
    );
    const api = fch.create({
      baseURL: data.apiUrl + API_VERSION_URL,
      headers: { Authorization: data.authorizationToken },
    });
    const bucketId = data.allowed.bucketId;
    const publicUrl = data.downloadUrl;
    baseInfo = { id: bucketId, bucketId, publicUrl, api, raw: data };
    return api;
  })();

  const makePublic = (url) => {
    const { publicUrl } = baseInfo;
    if (url.startsWith("/")) {
      url = publicUrl + "/file/" + name + url;
    }
    if (url && url.url) {
      url = url.url;
    }
    return url;
  };

  const toFile = (file) => {
    const path = ("/" + file.fileName).replace(/\/\//g, "/");
    return {
      id: file.fileId,
      name: file.fileName.split("/").pop(),
      path,
      type: file.contentType,
      size: file.contentLength,
      date: new Date(file.uploadTimestamp),
      // https://f345.backblazeb2.com/file/photos/cute/kitten.jpg
      url: makePublic(path),
    };
  };

  const info = swear(async () => {
    await apiPromise;
    return baseInfo;
  });

  async function* listGenerator(prefix, opts = {}) {
    opts = typeof prefix === "string" ? { ...opts, prefix } : prefix || {};
    prefix = opts.prefix;
    const limit = opts.limit || Infinity;
    const { api, id: bucketId } = await info();

    let i = 0;
    let startFileName;
    // The two escape conditions are inside
    do {
      // Avoid overfetching data (needs to be calculated each loop)
      const remaining = limit - i;
      const maxFileCount = remaining > PAGE_SIZE ? PAGE_SIZE : remaining;

      // Retrieve the actual data
      const query = { bucketId, prefix, maxFileCount, startFileName };
      const data = await api.get("/b2_list_file_names", { query });
      startFileName = data.nextFileName;

      for (let file of data.files) {
        yield toFile(file);
        i++;
      }
      // Reached the limit parameter, don't go any further
      // No more files to find in the bucket anyway
    } while (i < limit && startFileName);
  }

  const list = listFromGenerator(listGenerator);

  // Use the generator to avoid putting them all in memory
  const count = async (prefix) => {
    let i = 0;
    for await (let _ of list(prefix)) {
      i++;
    }
    return i;
  };

  const download = async (src, dst) => {
    const { api } = await info();
    src = makePublic(src);
    await mkdir(dirname(dst), { recursive: true });
    const data = await api.get(src, { output: "stream" });
    return await pipeline(data, createWriteStream(dst));
  };

  const upload = async (src, dst) => {
    const { api, id: bucketId } = await info();
    const data = await api.get("/b2_get_upload_url/", { query: { bucketId } });
    const { uploadUrl, authorizationToken } = data;
    const { size } = await stat(src);
    const headers = {
      Authorization: authorizationToken,
      "Content-Type": "b2/x-auto",
      "Content-Length": size,
      "X-Bz-File-Name": encodeURIComponent(dst),
      "X-Bz-Content-Sha1": await hashFile(src),
    };

    const body = createReadStream(src);
    const data2 = await api.post(uploadUrl, {
      headers,
      body,
    });
    return toFile(data2);
  };

  const write = async (dst, text) => {
    const { api, id: bucketId } = await info();
    const data = await api.get("/b2_get_upload_url/", { query: { bucketId } });
    const { uploadUrl, authorizationToken } = data;
    const headers = {
      Authorization: authorizationToken,
      "Content-Type": "b2/x-auto",
      "Content-Length": text.length,
      "X-Bz-File-Name": encodeURIComponent(dst),
      "X-Bz-Content-Sha1": await hashString(text),
    };

    const data2 = await api.post(uploadUrl, { headers, body: text });
    return toFile(data2);
  };

  const remove = async (prefix) => {
    const { api } = await info();
    const files = await list(prefix);
    let last;
    await Promise.all(
      files.map(async (file) => {
        last = file;
        while (await exists(file.path)) {
          const query = { fileName: file.path, fileId: file.id };
          await api.get("/b2_delete_file_version", { query });
        }
      })
    );
    return last;
  };

  const exists = async (src) => {
    const file = await list(src);
    return Boolean(file.length);
  };

  const todo = () => console.log("TODO");

  return {
    name: "Bucket/b2",
    info,
    count,
    list,
    upload,
    download,
    read: todo,
    write,
    remove,
    exists,
    copy: todo,
    sign: todo,
  };
}
