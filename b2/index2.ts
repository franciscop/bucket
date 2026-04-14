import "dotenv/config";

import fch from "fch";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import swear from "swear";

import listFromGenerator from "../lib/listFromGenerator.ts";

const API_VERSION_URL = "/b2api/v2/";

export const ENV_NAME = "B2_BUCKET";
export const ENV_ID = "B2_APPLICATION_KEY_ID";
export const ENV_KEY = "B2_APPLICATION_KEY";

const PAGE_SIZE = Number(process.env.PAGE_SIZE) || 10000;

const {
  B2_BUCKET: NAME,
  B2_APPLICATION_KEY_ID: ID,
  B2_APPLICATION_KEY: KEY,
} = process.env;

interface B2BaseInfo {
  id: string;
  bucketId: string;
  publicUrl: string;
  api: ReturnType<typeof fch.create>;
  raw: Record<string, unknown>;
}

interface B2File {
  id: string;
  name: string;
  path: string;
  type: string;
  size: number;
  date: Date;
  url: string;
}

interface B2RawFile {
  fileId: string;
  fileName: string;
  contentType: string;
  contentLength: number;
  uploadTimestamp: number;
}

interface B2ListOptions {
  prefix?: string;
  limit?: number;
}

const hashFile = (src: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const fd = createReadStream(src);
    const hp = createHash("sha1");
    hp.setEncoding("hex");
    fd.pipe(hp);
    fd.on("end", () => {
      hp.end();
      resolve(hp.read() as string);
    });
    fd.on("error", (err: Error) => {
      hp.end();
      reject(err);
    });
  });
};

const hashString = (str: string): string => {
  return createHash("sha1").update(str).digest("hex");
};

export default function BackBlazeV2(
  name: string = NAME || "",
  { id = ID || "", secret = KEY || "" }: { id?: string; secret?: string } = {},
) {
  let baseInfo: B2BaseInfo;

  const apiPromise: Promise<ReturnType<typeof fch.create>> = (async () => {
    const headerKey = Buffer.from(id + ":" + secret).toString("base64");
    const headers = { Authorization: "Basic " + headerKey };
    const data = (await fch(
      "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
      { headers },
    )) as {
      apiUrl: string;
      authorizationToken: string;
      allowed: { bucketId: string };
      downloadUrl: string;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (fch as any).create({
      baseURL: data.apiUrl + API_VERSION_URL,
      headers: { Authorization: data.authorizationToken },
    });
    const bucketId = data.allowed.bucketId;
    const publicUrl = data.downloadUrl;
    baseInfo = {
      id: bucketId,
      bucketId,
      publicUrl,
      api,
      raw: data as unknown as Record<string, unknown>,
    };
    return api;
  })();

  const makePublic = (url: string | { url?: string }): string => {
    const { publicUrl } = baseInfo;
    if (typeof url !== "string" && url?.url) {
      url = url.url as string;
    }
    if (typeof url === "string" && url.startsWith("/")) {
      url = publicUrl + "/file/" + name + url;
    }
    return url as string;
  };

  const toFile = (file: B2RawFile): B2File => {
    const path = ("/" + file.fileName).replace(/\/\//g, "/");
    return {
      id: file.fileId,
      name: file.fileName.split("/").pop()!,
      path,
      type: file.contentType,
      size: file.contentLength,
      date: new Date(file.uploadTimestamp),
      url: makePublic(path),
    };
  };

  const info = swear(async () => {
    await apiPromise;
    return baseInfo;
  });

  async function* listGenerator(
    prefixOrOpts?: string | B2ListOptions,
    opts: B2ListOptions = {},
  ): AsyncGenerator<B2File> {
    const resolvedOpts: B2ListOptions =
      typeof prefixOrOpts === "string"
        ? { ...opts, prefix: prefixOrOpts }
        : (prefixOrOpts as B2ListOptions) || {};
    const prefix = resolvedOpts.prefix;
    const limit = resolvedOpts.limit || Infinity;
    const { api, id: bucketId } = (await info()) as B2BaseInfo;

    let i = 0;
    let startFileName: string | undefined;
    do {
      const remaining = limit - i;
      const maxFileCount = remaining > PAGE_SIZE ? PAGE_SIZE : remaining;
      const query: Record<string, string> = Object.fromEntries(
        Object.entries({ bucketId, prefix, maxFileCount, startFileName })
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      );
      const data = (await api.get("/b2_list_file_names", { query })) as {
        nextFileName?: string;
        files: B2RawFile[];
      };
      startFileName = data.nextFileName;
      for (const file of data.files) {
        yield toFile(file);
        i++;
      }
    } while (i < limit && startFileName);
  }

  const list = listFromGenerator(listGenerator);

  const count = async (prefix?: string): Promise<number> => {
    let i = 0;
    for await (const _ of list(prefix)) {
      i++;
    }
    return i;
  };

  const download = async (src: string, dst: string): Promise<void> => {
    const { api } = (await info()) as B2BaseInfo;
    src = makePublic(src);
    await mkdir(dirname(dst), { recursive: true });
    const data = (await api.get(src, {
      output: "stream",
    })) as NodeJS.ReadableStream;
    await pipeline(data, createWriteStream(dst));
  };

  const upload = async (src: string, dst: string): Promise<B2File> => {
    const { api, id: bucketId } = (await info()) as B2BaseInfo;
    const data = (await api.get("/b2_get_upload_url/", {
      query: { bucketId },
    })) as { uploadUrl: string; authorizationToken: string };
    const { uploadUrl, authorizationToken } = data;
    const { size } = await stat(src);
    const headers: Record<string, string> = {
      Authorization: authorizationToken,
      "Content-Type": "b2/x-auto",
      "Content-Length": String(size),
      "X-Bz-File-Name": encodeURIComponent(dst),
      "X-Bz-Content-Sha1": await hashFile(src),
    };
    const body = createReadStream(src);
    const data2 = (await api.post(uploadUrl, body, { headers })) as B2RawFile;
    return toFile(data2);
  };

  const write = async (
    dst: string,
    text: string,
  ): Promise<B2File | undefined> => {
    const { api, id: bucketId } = (await info()) as B2BaseInfo;
    const data = (await api.get("/b2_get_upload_url/", {
      query: { bucketId },
    })) as { uploadUrl: string; authorizationToken: string };
    const { uploadUrl, authorizationToken } = data;
    const headers: Record<string, string> = {
      Authorization: authorizationToken,
      "Content-Type": "b2/x-auto",
      "Content-Length": String(text.length),
      "X-Bz-File-Name": encodeURIComponent(dst),
      "X-Bz-Content-Sha1": hashString(text),
    };
    try {
      const data2 = (await api.post(uploadUrl, text, { headers })) as B2RawFile;
      return toFile(data2);
    } catch (error) {
      console.log(error);
    }
  };

  const remove = async (path: string | B2File): Promise<void> => {
    const files = await list(typeof path === "string" ? path : path.path);
    const file = files[0] as B2File;
    const { api } = (await info()) as B2BaseInfo;
    while (await exists(file.path)) {
      const query = { fileName: file.path, fileId: file.id };
      await api.get("/b2_delete_file_version", { query });
    }
  };

  const clear = async (prefix: string): Promise<B2File | undefined> => {
    const files = await list(prefix);
    await Promise.all(files.map((f: unknown) => remove(f as B2File)));
    return files[files.length - 1] as B2File | undefined;
  };

  const exists = async (src: string): Promise<boolean> => {
    const file = await list(src);
    return Boolean(file.length);
  };

  const todo = (): void => console.log("TODO");

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
    clear,
    exists,
    copy: todo,
    sign: todo,
  };
}
