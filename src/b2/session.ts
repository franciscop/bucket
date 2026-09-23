// A B2 account session: the authorization token plus what the account told
// us about the bucket. Tokens expire after 24 hours, so a long-lived bucket
// has to re-authorize; the session lives in the context, which folder()
// copies by reference, so one refresh serves a bucket and every folder of it.
import { toBytes } from "../lib/bytes.ts";
import { toBase64 } from "../lib/webcrypto.ts";
import BucketError from "../lib/BucketError.ts";

const API_VERSION_URL = "/b2api/v2/";

export interface B2Auth {
  bucketId: string;
  bucketName: string;
  token: string;
  apiBase: string;
  /** Download origin, with a trailing slash. */
  base: string;
  absoluteMinimumPartSize: number;
}

// b2_authorize_account. `allowed` describes what the application key may do:
// a key restricted to one bucket names it, while master keys (and any key with
// account-wide access) leave bucketId/bucketName null and need a lookup.
interface B2AuthResponse {
  accountId: string;
  authorizationToken: string;
  apiUrl: string;
  downloadUrl: string;
  absoluteMinimumPartSize?: number;
  allowed: {
    capabilities?: string[];
    bucketId?: string | null;
    bucketName?: string | null;
    namePrefix?: string | null;
  };
}

const authError = (message: string, status?: number): never => {
  throw new BucketError(message, { provider: "BACKBLAZE", status });
};

// Plain fetch: these two calls are what produce the token every other
// request is authorized with, so they cannot go through Http themselves.
async function authorize(
  id: string,
  secret: string,
  name: string,
  knownBucketId = "",
): Promise<B2Auth> {
  const derived = toBase64(toBytes(id + ":" + secret));
  const res = await fetch(
    "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
    { headers: { Authorization: "Basic " + derived } },
  );
  if (!res.ok) authError(`B2 authorize error: ${res.status}`, res.status);
  const data = (await res.json()) as B2AuthResponse;
  const apiBase = data.apiUrl + API_VERSION_URL;
  const auth = {
    token: data.authorizationToken,
    apiBase,
    base: data.downloadUrl.replace(/\/$/, "") + "/",
    absoluteMinimumPartSize: data.absoluteMinimumPartSize ?? 5 * 1024 * 1024,
  };

  // A bucket-restricted key already tells us the bucket: use it, and make sure
  // it is the one that was asked for instead of silently working on another.
  const allowedId = data.allowed?.bucketId ?? "";
  const allowedName = data.allowed?.bucketName ?? "";
  if (allowedId) {
    if (name && allowedName && name !== allowedName)
      authError(
        `B2 key is restricted to the bucket "${allowedName}", so it cannot be used for "${name}"`,
      );
    return { ...auth, bucketId: allowedId, bucketName: allowedName || name };
  }

  // A re-authorization already knows the id, so skip the lookup below.
  if (knownBucketId)
    return { ...auth, bucketId: knownBucketId, bucketName: name };

  // Otherwise the id has to be looked up by name, which needs both a name and
  // the listBuckets capability.
  if (!name)
    authError(
      "B2 needs a bucket name: this key is not restricted to a single bucket, so pass one to BackBlaze() or set B2_BUCKET",
    );
  if (data.allowed?.capabilities?.includes("listBuckets") === false)
    authError(
      `B2 cannot resolve the bucket "${name}": this key is not restricted to a bucket and lacks the "listBuckets" capability. Use a bucket-restricted key, or grant it listBuckets.`,
    );
  const url =
    apiBase +
    "b2_list_buckets?accountId=" +
    encodeURIComponent(data.accountId) +
    "&bucketName=" +
    encodeURIComponent(name);
  const listRes = await fetch(url, { headers: { Authorization: auth.token } });
  if (!listRes.ok)
    authError(
      `B2 cannot resolve the bucket "${name}": list buckets failed with ${listRes.status}`,
      listRes.status,
    );
  const { buckets } = (await listRes.json()) as {
    buckets?: { bucketId: string; bucketName: string }[];
  };
  const found = buckets?.find((b) => b.bucketName === name);
  if (!found)
    authError(
      `B2 bucket "${name}" does not exist, or this key cannot access it`,
    );
  return { ...auth, bucketId: found!.bucketId, bucketName: name };
}

export class B2Session {
  #id: string;
  #secret: string;
  #name: string;
  #auth: Promise<B2Auth>;
  // The token currently in use; "" while a refresh is in flight.
  #token = "";

  constructor(id: string, secret: string, name: string) {
    this.#id = id;
    this.#secret = secret;
    this.#name = name;
    this.#auth = this.#adopt(authorize(id, secret, name));
  }

  #adopt(auth: Promise<B2Auth>): Promise<B2Auth> {
    // The rejection resurfaces wherever the auth is awaited.
    auth.then(
      (a) => {
        this.#token = a.token;
      },
      () => {},
    );
    return auth;
  }

  get(): Promise<B2Auth> {
    return this.#auth;
  }

  /** Re-authorizes because `token` was rejected as expired. Only the first
   * caller with the current token re-authorizes; every other one, and any
   * later caller still holding an old token, awaits that same replacement. */
  async refresh(token: string): Promise<void> {
    if (token && token === this.#token) {
      this.#token = "";
      const stale = this.#auth;
      this.#auth = this.#adopt(
        stale
          .then((a) =>
            authorize(this.#id, this.#secret, a.bucketName, a.bucketId),
          )
          .catch(() => authorize(this.#id, this.#secret, this.#name)),
      );
    }
    await this.#auth;
  }
}
