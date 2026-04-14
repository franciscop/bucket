import "dotenv/config";

import fch from "fch";
import xml from "xml-js";

import cleanAndSignS3 from "../lib/cleanAndSignS3.ts";
import type { S3Request, S3Auth } from "../lib/types.ts";

const {
  R2_ENDPOINT: URI,
  R2_ACCESS_KEY_ID: ID,
  R2_SECRET_ACCESS_KEY: KEY,
  R2_REGION: REGION,
} = process.env;

interface R2FileEntry {
  id: string;
  name: string;
  path: string;
  type: string;
  size: number;
  date: Date;
}

interface FchLike {
  get: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  head: (
    url: string,
    options?: Record<string, unknown>,
  ) => { raw: () => Promise<Response> };
}

function request(config: S3Request & { s3config?: S3Auth }): Promise<Response> {
  cleanAndSignS3(config, config.s3config!);
  return fetch(config.url, config as unknown as RequestInit);
}

// Based on https://github.com/nashwaan/xml-js/issues/53
function parseResponse(res: { body?: unknown; data?: unknown }): typeof res {
  function nativeType(value: string): string | number | boolean {
    const nValue = Number(value);
    if (!isNaN(nValue)) return nValue;
    const bValue = value.toLowerCase();
    if (bValue === "true") return true;
    if (bValue === "false") return false;
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    return value;
  }

  const removeJsonTextAttribute = (
    value: string,
    parentElement: Record<string, unknown> & {
      _parent?: Record<string, unknown>;
    },
  ): void => {
    try {
      const keyNo = Object.keys(parentElement._parent!).length;
      const keyName = Object.keys(parentElement._parent!)[keyNo - 1];
      (parentElement._parent as Record<string, unknown>)[keyName] =
        nativeType(value);
    } catch (_e) {}
  };

  const options: xml.Options.XML2JSON = {
    compact: true,
    ignoreDeclaration: true,
    ignoreInstruction: true,
    ignoreAttributes: true,
    ignoreComment: true,
    ignoreCdata: true,
    ignoreDoctype: true,
    textFn: removeJsonTextAttribute as xml.Options.XML2JSON["textFn"],
  };

  res.body = JSON.parse(
    xml.xml2json((res.data || res.body) as string, options),
  );
  return res;
}

export default function CloudflareR2(
  baseURL: string = URI || "",
  s3config: Partial<S3Auth> = {},
) {
  if (!s3config.id) s3config.id = ID || "";
  if (!s3config.secret) s3config.secret = KEY || "";
  if (!s3config.region) s3config.region = REGION || "us-east-1";

  const api = (
    fch as unknown as { create: (opts: Record<string, unknown>) => FchLike }
  ).create({
    baseURL,
    before: (req: S3Request) => cleanAndSignS3(req, s3config as S3Auth),
    after: parseResponse,
  });

  async function list(): Promise<R2FileEntry[]> {
    const data = (await api.get("")) as {
      ListBucketResult: {
        Contents: Array<{
          ETag: string;
          Key: string;
          Size: number;
          LastModified: string;
        }>;
      };
    };
    const content = data.ListBucketResult.Contents;
    return content.map((item) => ({
      id: item.ETag as string,
      name: (item.Key as string).split("/").pop()!,
      path: "/" + (item.Key as string).replace(/^\//, ""),
      type: (item.Key as string).split(".").pop()!,
      size: item.Size as number,
      date: new Date(item.LastModified as string),
    }));
  }

  async function exists(file: string): Promise<boolean> {
    const res = await api.head(file, { error: (e: unknown) => e }).raw();
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    throw new Error("Error Status " + res.status);
  }

  return { list, exists };
}
