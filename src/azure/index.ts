import { signAzure, accountPathPrefix } from "../lib/signAzure.ts";
import { unescapeXml, extractTags, getTag } from "../lib/xml.ts";
import BucketError from "../lib/BucketError.ts";
import { scope } from "../lib/prefix.ts";
import { throwIfAborted, type ReadOptions } from "../lib/abort.ts";
import { Http } from "../lib/http.ts";
import { BaseBucket } from "../lib/base.ts";
import type { BucketInfo } from "../lib/types.ts";
import { AzureFile, type AzureContext, type AzureFileAuth } from "./File.ts";

const {
  AZURE_ACCOUNT: ENV_ACCOUNT,
  AZURE_CONTAINER: ENV_CONTAINER,
  AZURE_KEY: ENV_KEY,
  AZURE_URL: ENV_URL,
  AZURE_PUBLIC_URL: ENV_PUBLIC_URL,
  AZURE_CONNECTION_STRING: ENV_CONNECTION_STRING,
} = process.env;

export interface AzureConfig {
  /** Storage account name (falls back to `AZURE_ACCOUNT`) */
  account?: string;
  /** Base64-encoded storage account key (falls back to `AZURE_KEY`).
   * Omit to use Managed Identity (Azure VMs, App Service, Container Apps, etc.) */
  key?: string;
  /** Override the blob host (falls back to `AZURE_URL`). Use for the Azurite
   * emulator or sovereign clouds, e.g. `http://127.0.0.1:10000/devstoreaccount1`. */
  url?: string;
  /** Full Azure connection string (falls back to `AZURE_CONNECTION_STRING`).
   * When present, its account, key, and BlobEndpoint are used. */
  connectionString?: string;
  /** Public origin the container is served from, e.g. a Front Door domain
   * (falls back to `AZURE_PUBLIC_URL`). Used by `file.publicUrl()`. */
  publicUrl?: string;
}

const invalid = (message: string): never => {
  throw new BucketError(message, { code: "INVALID_CONFIG" });
};

// The account in a blob URL is the subdomain (`<account>.blob.core.windows.net`)
// or, for path-style emulators, the first path segment
// (`http://127.0.0.1:10000/devstoreaccount1`). Account names are dot-free, so
// both are unambiguous.
function accountFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.replace(/^\/+|\/+$/g, "").split("/")[0];
    return seg || u.hostname.split(".")[0] || "";
  } catch {
    return "";
  }
}

function parseConnectionString(cs: string) {
  const map: Record<string, string> = {};
  for (const part of cs.split(";")) {
    const idx = part.indexOf("=");
    if (idx !== -1) map[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return {
    account: map["AccountName"] ?? "",
    key: map["AccountKey"] ?? "",
    // Honoured by emulators (Azurite) and custom/sovereign clouds. When present
    // it already includes the account path, e.g. http://127.0.0.1:10000/devstoreaccount1
    url: map["BlobEndpoint"],
  };
}

/** Caches the Managed Identity token. Lives in the context, so folders
 * share one instead of each fetching its own. */
function managedToken() {
  let cache: { token: string; expiry: number } | null = null;
  return async (): Promise<string> => {
    if (cache && Date.now() < cache.expiry) return cache.token;
    const res = await fetch(
      "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://storage.azure.com/",
      { headers: { Metadata: "true" } },
    );
    if (!res.ok)
      throw new BucketError("Azure Managed Identity token fetch failed", {
        provider: "Azure",
        status: res.status,
        code: "UNAUTHORIZED",
      });
    const data = (await res.json()) as {
      access_token: string;
      expires_in: string;
    };
    cache = {
      token: data.access_token,
      expiry: Date.now() + (parseInt(data.expires_in) - 60) * 1000,
    };
    return cache.token;
  };
}

function azureContext(
  account: string,
  container: string,
  key: string,
  url: string,
  publicUrl: string,
): AzureContext {
  // A custom url embeds the account, so make sure it agrees with the account.
  if (url && account) {
    const derived = accountFromUrl(url);
    if (derived && derived !== account)
      invalid(
        `Azure account "${account}" does not match the account in url "${url}"`,
      );
  }
  const getToken = managedToken();
  const auth: AzureFileAuth = key
    ? { type: "shared-key", key }
    : { type: "managed-identity", getToken };
  // Default to the public cloud host; an explicit url (emulator, custom
  // or sovereign cloud) overrides it and already includes the account path.
  const host =
    url.replace(/\/$/, "") || `https://${account}.blob.core.windows.net`;
  return {
    provider: "Azure",
    prefix: "",
    publicUrl: publicUrl.replace(/\/+$/, ""),
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
          ...(req.body !== undefined
            ? { "Content-Length": String(Buffer.byteLength(req.body)) }
            : {}),
        };
        if (auth.type === "shared-key") {
          // SharedKey signs the canonical resource, which is the account path
          // plus the container and blob, and every query parameter.
          const path = u.pathname.replace(accountPathPrefix(host), "");
          return {
            ...req,
            headers: await signAzure(
              req.method,
              `${accountPathPrefix(host)}${path}`,
              headers,
              { account, key: auth.key },
              Object.keys(params).length ? params : undefined,
            ),
          };
        }
        return {
          ...req,
          headers: {
            ...headers,
            "x-ms-date": new Date().toUTCString(),
            "x-ms-version": "2020-10-02",
            Authorization: `Bearer ${await getToken()}`,
          },
        };
      },
    }),
  };
}

class AzureBucket extends BaseBucket<AzureContext, AzureFile> {
  readonly type = "AZURE";

  protected make(key: string): AzureFile {
    return new AzureFile(key, this.ctx);
  }

  async info(opts?: ReadOptions): Promise<BucketInfo> {
    throwIfAborted(opts?.signal);
    const { account, container, url } = this.ctx;
    return {
      type: this.type,
      name: container,
      url: `${url}/${container}`,
      id: account,
    };
  }

  protected async *pages(filter?: RegExp, opts?: ReadOptions) {
    let marker: string | undefined;
    const s = scope(this.PREFIX, filter);
    const { container, url } = this.ctx;
    do {
      const params: Record<string, string> = {
        restype: "container",
        comp: "list",
        ...(s.query ? { prefix: s.query } : {}),
        ...(marker ? { marker } : {}),
      };
      const res = await this.ctx.http.send(
        "GET",
        `${url}/${container}?${new URLSearchParams(params)}`,
        { signal: opts?.signal, what: "list" },
      );
      const xml = await res.text();
      yield extractTags(xml, "Blob")
        .map((item) => unescapeXml(getTag(item, "Name")))
        .filter((name) => s.test(name))
        .map((name) => this.make(name));
      marker = getTag(xml, "NextMarker") || undefined;
    } while (marker);
  }
}

/**
 * Create an Azure Blob Storage container handle.
 *
 * @param container - Container name (falls back to `AZURE_CONTAINER` env var)
 * @param config.account - Storage account name (falls back to `AZURE_ACCOUNT`)
 * @param config.key - Base64-encoded storage account key (falls back to `AZURE_KEY`).
 *   Omit to use Managed Identity (Azure VMs, App Service, Container Apps, etc.)
 * @param config.url - Override the blob host (falls back to `AZURE_URL`). Use for
 *   the Azurite emulator or sovereign clouds, e.g.
 *   `http://127.0.0.1:10000/devstoreaccount1`.
 * @param config.connectionString - Full Azure connection string (falls back to
 *   `AZURE_CONNECTION_STRING`). Its account, key, and BlobEndpoint are used.
 * @param config.publicUrl - Public origin for `file.publicUrl()` (falls back to `AZURE_PUBLIC_URL`)
 *
 * @example
 * const bucket = Azure("mycontainer", { account: "myaccount", key: "base64key==" });
 */
export default function Azure(
  container: string = ENV_CONTAINER || "",
  config: AzureConfig = {},
): AzureBucket {
  const cs = config.connectionString ?? ENV_CONNECTION_STRING;
  if (cs) {
    const parsed = parseConnectionString(cs);
    // A connection string carries its own account; an explicit one must match.
    if (config.account && config.account !== parsed.account)
      invalid(
        `Azure account "${config.account}" does not match the AccountName "${parsed.account}" in the connection string`,
      );
    return new AzureBucket(
      azureContext(
        parsed.account,
        container,
        parsed.key,
        config.url || parsed.url || "",
        config.publicUrl ?? ENV_PUBLIC_URL ?? "",
      ),
    );
  }
  return new AzureBucket(
    azureContext(
      config.account ?? ENV_ACCOUNT ?? "",
      container,
      config.key ?? ENV_KEY ?? "",
      config.url ?? ENV_URL ?? "",
      config.publicUrl ?? ENV_PUBLIC_URL ?? "",
    ),
  );
}

export type { AzureFileAuth };
export type {
  Bucket,
  BucketFile,
  FileInfo,
  BucketInfo,
  WriteContent,
  WriteOptions,
} from "../lib/types.ts";
