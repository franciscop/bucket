import { signAzure, accountPathPrefix } from "../lib/signAzure.ts";
import BucketError from "../lib/BucketError.ts";
import { withPrefix, scope, joinPrefix } from "../lib/prefix.ts";
import type { Bucket, BucketInfo } from "../lib/types.ts";
import { AzureFile, type AzureFileAuth } from "./File.ts";

const {
  AZURE_ACCOUNT: ENV_ACCOUNT,
  AZURE_CONTAINER: ENV_CONTAINER,
  AZURE_KEY: ENV_KEY,
  AZURE_ENDPOINT: ENV_ENDPOINT,
} = process.env;

function extractXmlTags(xml: string, tag: string): string[] {
  const results: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) results.push(m[1]);
  return results;
}

function getXmlTag(xml: string, tag: string): string {
  return extractXmlTags(xml, tag)[0] ?? "";
}

function parseConnectionString(cs: string): {
  account: string;
  key: string;
  endpoint?: string;
} {
  const map: Record<string, string> = {};
  for (const part of cs.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    map[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return {
    account: map["AccountName"] ?? "",
    key: map["AccountKey"] ?? "",
    // Honoured by emulators (Azurite) and custom/sovereign clouds. When present
    // it already includes the account path, e.g. http://127.0.0.1:10000/devstoreaccount1
    endpoint: map["BlobEndpoint"],
  };
}

class AzureBucket implements Bucket {
  readonly type = "AZURE";
  #account: string;
  #container: string;
  #endpoint: string;
  #auth: AzureFileAuth;
  #tokenCache: { token: string; expiry: number } | null = null;
  PREFIX = "";

  constructor(
    account: string = ENV_ACCOUNT || "",
    container: string = ENV_CONTAINER || "",
    key: string = ENV_KEY || "",
    endpoint: string = ENV_ENDPOINT || "",
  ) {
    this.#account = account;
    this.#container = container;
    // Default to the public cloud host; an explicit endpoint (emulator, custom
    // or sovereign cloud) overrides it and already includes the account path.
    this.#endpoint =
      endpoint.replace(/\/$/, "") || `https://${account}.blob.core.windows.net`;
    this.#auth = key
      ? { type: "shared-key", key }
      : {
          type: "managed-identity",
          getToken: () => this.#getManagedIdentityToken(),
        };
  }

  async #getManagedIdentityToken(): Promise<string> {
    if (this.#tokenCache && Date.now() < this.#tokenCache.expiry) {
      return this.#tokenCache.token;
    }
    const res = await fetch(
      "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://storage.azure.com/",
      { headers: { Metadata: "true" } },
    );
    if (!res.ok) throw new Error("Azure Managed Identity token fetch failed");
    const data = (await res.json()) as {
      access_token: string;
      expires_in: string;
    };
    this.#tokenCache = {
      token: data.access_token,
      expiry: Date.now() + (parseInt(data.expires_in) - 60) * 1000,
    };
    return this.#tokenCache.token;
  }

  async info(): Promise<BucketInfo> {
    return {
      type: this.type,
      name: this.#container,
      endpoint: `${this.#endpoint}/${this.#container}`,
      id: this.#account,
    };
  }

  async *#pages(filter?: RegExp): AsyncGenerator<AzureFile[]> {
    let marker: string | undefined;
    const s = scope(this.PREFIX, filter);

    do {
      const containerPath = `${accountPathPrefix(this.#endpoint)}/${this.#container}`;
      const params: Record<string, string> = {
        restype: "container",
        comp: "list",
        ...(s.query ? { prefix: s.query } : {}),
        ...(marker ? { marker } : {}),
      };
      const query = new URLSearchParams(params).toString();
      const url = `${this.#endpoint}/${this.#container}?${query}`;

      let headers: Record<string, string>;
      if (this.#auth.type === "shared-key") {
        headers = await signAzure(
          "GET",
          containerPath,
          {},
          { account: this.#account, key: this.#auth.key },
          params,
        );
      } else {
        const token = await this.#getManagedIdentityToken();
        headers = {
          "x-ms-date": new Date().toUTCString(),
          "x-ms-version": "2020-10-02",
          Authorization: `Bearer ${token}`,
        };
      }

      const res = await fetch(url, { headers });
      if (!res.ok)
        throw new BucketError(`Azure list error: ${res.status}`, {
          provider: "Azure",
          status: res.status,
        });

      const xml = await res.text();
      const page: AzureFile[] = [];
      for (const item of extractXmlTags(xml, "Blob")) {
        const name = getXmlTag(item, "Name");
        if (!s.test(name)) continue;
        page.push(
          new AzureFile(
            name,
            this.#account,
            this.#container,
            this.#auth,
            this.#endpoint,
          ),
        );
      }
      yield page;

      marker = getXmlTag(xml, "NextMarker") || undefined;
    } while (marker);
  }

  async *scan(filter?: RegExp): AsyncGenerator<AzureFile> {
    for await (const page of this.#pages(filter)) yield* page;
  }

  async list(filter?: RegExp): Promise<AzureFile[]> {
    const files: AzureFile[] = [];
    for await (const page of this.#pages(filter)) files.push(...page);
    return files;
  }

  file(name: string): AzureFile {
    if (!name) throw new Error("No name");
    return new AzureFile(
      withPrefix(this.PREFIX, name),
      this.#account,
      this.#container,
      this.#auth,
      this.#endpoint,
    );
  }

  folder(path: string): AzureBucket {
    const key = this.#auth.type === "shared-key" ? this.#auth.key : "";
    const sub = new AzureBucket(
      this.#account,
      this.#container,
      key,
      this.#endpoint,
    );
    sub.PREFIX = joinPrefix(this.PREFIX, path);
    return sub;
  }

  async remove(filter?: RegExp): Promise<AzureFile[]> {
    const files = await this.list(filter);
    await Promise.all(files.map((f) => f.remove()));
    return files;
  }

  async count(filter?: RegExp): Promise<number> {
    return (await this.list(filter)).length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AzureFile> {
    yield* this.scan();
  }
}

/**
 * Create an Azure Blob Storage container handle.
 *
 * @param accountOrConnectionString - Storage account name or a full Azure connection string
 *   (falls back to `AZURE_ACCOUNT` env var)
 * @param container - Container name (falls back to `AZURE_CONTAINER`)
 * @param key - Base64-encoded storage account key (falls back to `AZURE_KEY`).
 *   Omit to use Managed Identity (Azure VMs, App Service, Container Apps, etc.)
 *
 * @example
 * // Static credentials
 * const bucket = Azure("myaccount", "mycontainer", "base64key==");
 *
 * @example
 * // Connection string
 * const bucket = Azure("DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;");
 *
 * @example
 * // Managed Identity (no key needed on Azure-hosted infra)
 * const bucket = Azure("myaccount", "mycontainer");
 *
 * @param options.endpoint - Override the blob host (falls back to `AZURE_ENDPOINT`).
 *   Use for the Azurite emulator or sovereign clouds, e.g.
 *   `http://127.0.0.1:10000/devstoreaccount1`. A connection string's
 *   `BlobEndpoint` is honoured automatically.
 */
export default function Azure(
  accountOrConnectionString?: string,
  container?: string,
  key?: string,
  options?: { endpoint?: string },
): AzureBucket {
  if (accountOrConnectionString?.includes("AccountName=")) {
    const parsed = parseConnectionString(accountOrConnectionString);
    return new AzureBucket(
      parsed.account,
      container || ENV_CONTAINER || "",
      parsed.key,
      options?.endpoint || parsed.endpoint,
    );
  }
  return new AzureBucket(
    accountOrConnectionString,
    container,
    key,
    options?.endpoint,
  );
}

export type {
  Bucket,
  BucketFile,
  FileInfo,
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
