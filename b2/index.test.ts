// This test only covers the things specific for this bucket;
// any shared API test is under test/index.test.ts at the root

import BackBlaze from "./index.ts";

// All tests use mocked fetch, no real credentials needed.
// The B2 constructor fires an auth request immediately, so we mock fetch
// before constructing the bucket and use withAuthMock() to intercept it.

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function mockFetch(handler: FetchHandler): void {
  globalThis.fetch = handler as typeof fetch;
}

function makeResponse(
  body: string | null,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

const AUTH_RESPONSE = {
  accountId: "test-account",
  allowed: {
    capabilities: ["listFiles", "readFiles", "writeFiles"],
    bucketId: "test-bucket-id",
    bucketName: "test-bucket",
    namePrefix: null,
  },
  authorizationToken: "test-auth-token",
  apiUrl: "https://api.backblazeb2.com",
  downloadUrl: "https://f001.backblazeb2.com",
};

// b2_authorize_account leaves allowed.bucketId null for master keys and any
// key with account-wide access; the bucket then has to be looked up by name.
const UNRESTRICTED_AUTH = {
  ...AUTH_RESPONSE,
  allowed: {
    capabilities: ["listBuckets", "listFiles", "readFiles", "writeFiles"],
    bucketId: null,
    bucketName: null,
    namePrefix: null,
  },
};

const CREDS = { id: "test-id", secret: "test-key" };

// Answer auth with the given response; everything else is up to the handler.
function withAuth(auth: unknown, handler?: FetchHandler): void {
  mockFetch((url, init) => {
    if ((url as string).includes("b2_authorize_account"))
      return Promise.resolve(makeResponse(JSON.stringify(auth)));
    return handler
      ? handler(url as string, init)
      : Promise.resolve(makeResponse("{}"));
  });
}

// Wrap a fetch handler so B2's auth request is always answered correctly.
function withAuthMock(
  handler: FetchHandler = () => Promise.resolve(makeResponse(null)),
): FetchHandler {
  return (url, init) => {
    if ((url as string).includes("b2_authorize_account")) {
      return Promise.resolve(makeResponse(JSON.stringify(AUTH_RESPONSE)));
    }
    return handler(url as string, init);
  };
}

// Create a bucket with mocked auth, await init, then hand control to caller.
async function makeBucket(
  handler?: FetchHandler,
): Promise<ReturnType<typeof BackBlaze>> {
  mockFetch(withAuthMock(handler));
  const bucket = BackBlaze("test-bucket", {
    id: "test-id",
    secret: "test-key",
  });
  await bucket.info(); // waits for initPromise to settle
  return bucket;
}

const B2_LIST_RESPONSE = {
  files: [
    {
      fileName: "hello.txt",
      fileId: "id-hello",
      contentType: "text/plain",
      contentLength: 5,
      uploadTimestamp: 1704067200000,
    },
    {
      fileName: "data/world.json",
      fileId: "id-world",
      contentType: "application/json",
      contentLength: 25,
      uploadTimestamp: 1704153600000,
    },
  ],
  nextFileName: null,
};

describe("B2 token refresh", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // B2 tokens last 24h, so a long-lived bucket has to survive one expiring.
  // Issues tok-1, tok-2, ...; expire(token) makes B2 reject that one from then
  // on, exactly as it does once the 24h window closes.
  function mockExpiry() {
    const counts = { auths: 0, lookups: 0 };
    const dead = new Set<string>();
    mockFetch((url, init) => {
      const u = url as string;
      if (u.includes("b2_authorize_account")) {
        counts.auths++;
        return Promise.resolve(
          makeResponse(
            JSON.stringify({
              ...UNRESTRICTED_AUTH,
              authorizationToken: "tok-" + counts.auths,
            }),
          ),
        );
      }
      if (u.includes("b2_list_buckets")) {
        counts.lookups++;
        return Promise.resolve(
          makeResponse(
            JSON.stringify({
              buckets: [
                { bucketId: "test-bucket-id", bucketName: "test-bucket" },
              ],
            }),
          ),
        );
      }
      const token = new Headers(init?.headers).get("authorization") ?? "";
      if (dead.has(token)) {
        return Promise.resolve(
          makeResponse(
            JSON.stringify({
              status: 401,
              code: "expired_auth_token",
              message: "expired",
            }),
            401,
            { "content-type": "application/json" },
          ),
        );
      }
      return Promise.resolve(
        makeResponse(JSON.stringify({ files: [], nextFileName: null })),
      );
    });
    return { counts, expire: (token: string) => dead.add(token) };
  }

  it("re-authorizes and retries, so the caller sees no error", async () => {
    const m = mockExpiry();
    const bucket = BackBlaze("test-bucket", CREDS);
    await bucket.list();
    expect(m.counts.auths).toBe(1);

    m.expire("tok-1");
    await bucket.list(); // 401 -> re-authorize -> retry, transparently
    expect(m.counts.auths).toBe(2);
    // The bucket id is already known, so the refresh skips the name lookup
    expect(m.counts.lookups).toBe(1);
  });

  it("re-authorizes once for concurrent expired requests", async () => {
    const m = mockExpiry();
    const bucket = BackBlaze("test-bucket", CREDS);
    await bucket.list();
    m.expire("tok-1");
    await Promise.all([
      bucket.list(),
      bucket.list(),
      bucket.list(),
      bucket.list(),
    ]);
    expect(m.counts.auths).toBe(2); // one initial, one shared refresh
  });

  it("shares the refresh between a bucket and its folders", async () => {
    const m = mockExpiry();
    const bucket = BackBlaze("test-bucket", CREDS);
    const folder = bucket.folder("photos"); // cloned before any refresh
    await bucket.list();

    m.expire("tok-1");
    await folder.list(); // the folder refreshes
    expect(m.counts.auths).toBe(2);

    await bucket.list(); // and the root is already on the new token
    expect(m.counts.auths).toBe(2);
  });

  it("does not re-authorize when the caller brought its own token", async () => {
    // B2 upload URLs carry a separate token, which re-authorizing the account
    // would not renew, so a 401 there must surface instead of retrying.
    let auths = 0;
    mockFetch((url, init) => {
      if ((url as string).includes("b2_authorize_account")) {
        auths++;
        return Promise.resolve(makeResponse(JSON.stringify(AUTH_RESPONSE)));
      }
      if (new Headers(init?.headers).get("authorization") === "upload-token") {
        return Promise.resolve(
          makeResponse(
            JSON.stringify({
              status: 401,
              code: "expired_auth_token",
              message: "x",
            }),
            401,
            { "content-type": "application/json" },
          ),
        );
      }
      return Promise.resolve(makeResponse("{}"));
    });
    const bucket = BackBlaze("test-bucket", CREDS);
    await bucket.info();
    await expect(
      bucket.fetch("https://upload.example/x", {
        headers: { Authorization: "upload-token" },
      }),
    ).rejects.toThrow(/401/);
    expect(auths).toBe(1);
  });
});

describe("B2 bucket resolution at auth", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("looks the bucket up by name when the key is not bucket-restricted", async () => {
    let listUrl = "";
    let listAuth = "";
    withAuth(UNRESTRICTED_AUTH, (url, init) => {
      if ((url as string).includes("b2_list_buckets")) {
        listUrl = url as string;
        listAuth = new Headers(init?.headers).get("authorization") ?? "";
        return Promise.resolve(
          makeResponse(
            JSON.stringify({
              buckets: [
                { bucketId: "other-id", bucketName: "another-bucket" },
                { bucketId: "resolved-id", bucketName: "test-bucket" },
              ],
            }),
          ),
        );
      }
      return Promise.resolve(makeResponse("{}"));
    });

    const bucket = BackBlaze("test-bucket", CREDS);
    const info = await bucket.info();
    expect(info.id).toBe("resolved-id");
    expect(info.name).toBe("test-bucket");
    expect(listUrl).toContain("accountId=test-account");
    expect(listUrl).toContain("bucketName=test-bucket");
    expect(listAuth).toBe("test-auth-token");
  });

  it("explains that listBuckets is needed when the key lacks it", async () => {
    withAuth({
      ...UNRESTRICTED_AUTH,
      allowed: { ...UNRESTRICTED_AUTH.allowed, capabilities: ["listFiles"] },
    });
    const bucket = BackBlaze("test-bucket", CREDS);
    await expect(bucket.info()).rejects.toThrow(/listBuckets/);
  });

  it("asks for a bucket name when the key does not imply one", async () => {
    withAuth(UNRESTRICTED_AUTH);
    const bucket = BackBlaze("", CREDS);
    await expect(bucket.info()).rejects.toThrow(/needs a bucket name/);
  });

  it("says so when the bucket does not exist", async () => {
    withAuth(UNRESTRICTED_AUTH, (url) => {
      if ((url as string).includes("b2_list_buckets"))
        return Promise.resolve(makeResponse(JSON.stringify({ buckets: [] })));
      return Promise.resolve(makeResponse("{}"));
    });
    const bucket = BackBlaze("missing-bucket", CREDS);
    await expect(bucket.info()).rejects.toThrow(
      /"missing-bucket" does not exist/,
    );
  });

  it("refuses a name the restricted key cannot access", async () => {
    // Silently using the key's own bucket would send writes and reads to
    // different buckets, so this must fail loudly instead.
    withAuth(AUTH_RESPONSE);
    const bucket = BackBlaze("some-other-bucket", CREDS);
    await expect(bucket.info()).rejects.toThrow(
      /restricted to the bucket "test-bucket"/,
    );
  });

  it("adopts the restricted key's bucket name when none is given", async () => {
    withAuth(AUTH_RESPONSE);
    const bucket = BackBlaze("", CREDS);
    const info = await bucket.info();
    expect(info.name).toBe("test-bucket");
    expect(info.id).toBe("test-bucket-id");
    expect(await bucket.file("a.txt").publicUrl()).toBe(
      "https://f001.backblazeb2.com/file/test-bucket/a.txt",
    );
  });

  it("surfaces a failed authorization instead of a later confusing error", async () => {
    mockFetch(() => Promise.resolve(makeResponse("nope", 401)));
    const bucket = BackBlaze("test-bucket", CREDS);
    await expect(bucket.info()).rejects.toThrow(/B2 authorize error: 401/);
  });
});

describe("B2 bucket.info()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns correct bucket info", async () => {
    const bucket = await makeBucket();
    const info = await bucket.info();
    expect(info.id).toBe("test-bucket-id");
    expect(info.name).toBe("test-bucket");
    expect(info.type).toBe("BACKBLAZE");
    expect(info.url).toBe("https://f001.backblazeb2.com/");
  });
});

describe("B2 bucket.list()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns files from B2 list API", async () => {
    const bucket = await makeBucket((url) => {
      if ((url as string).includes("b2_list_file_names"))
        return Promise.resolve(makeResponse(JSON.stringify(B2_LIST_RESPONSE)));
      return Promise.resolve(makeResponse(null));
    });
    const files = await bucket.list();
    expect(files.length).toBe(2);
  });

  it("returns correct file names and paths", async () => {
    const bucket = await makeBucket((url) => {
      if ((url as string).includes("b2_list_file_names"))
        return Promise.resolve(makeResponse(JSON.stringify(B2_LIST_RESPONSE)));
      return Promise.resolve(makeResponse(null));
    });
    const files = await bucket.list();
    expect(files[0].name).toBe("hello.txt");
    expect(files[0].path).toBe("hello.txt");
    expect(files[1].name).toBe("world.json");
    expect(files[1].path).toBe("data/world.json");
  });

  it("returns plain file handles (name and path only)", async () => {
    const bucket = await makeBucket((url) => {
      if ((url as string).includes("b2_list_file_names"))
        return Promise.resolve(makeResponse(JSON.stringify(B2_LIST_RESPONSE)));
      return Promise.resolve(makeResponse(null));
    });
    const files = await bucket.list();
    expect(files[0].name).toBe("hello.txt");
    expect(files[0].path).toBe("hello.txt");
  });

  it("handles empty bucket", async () => {
    const bucket = await makeBucket((url) => {
      if ((url as string).includes("b2_list_file_names"))
        return Promise.resolve(
          makeResponse(JSON.stringify({ files: [], nextFileName: null })),
        );
      return Promise.resolve(makeResponse(null));
    });
    const files = await bucket.list();
    expect(files).toEqual([]);
  });

  it("follows pagination via nextFileName", async () => {
    let listCalls = 0;
    const bucket = await makeBucket((url) => {
      if ((url as string).includes("b2_list_file_names")) {
        listCalls++;
        const page =
          listCalls === 1
            ? {
                files: [
                  {
                    fileName: "a.txt",
                    fileId: "id-a",
                    contentType: "text/plain",
                    contentLength: 1,
                    uploadTimestamp: 0,
                  },
                ],
                nextFileName: "b.txt",
              }
            : {
                files: [
                  {
                    fileName: "b.txt",
                    fileId: "id-b",
                    contentType: "text/plain",
                    contentLength: 1,
                    uploadTimestamp: 0,
                  },
                ],
                nextFileName: null,
              };
        return Promise.resolve(makeResponse(JSON.stringify(page)));
      }
      return Promise.resolve(makeResponse(null));
    });
    const files = await bucket.list();
    expect(files.length).toBe(2);
    expect(files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
    expect(listCalls).toBe(2);
  });

  it("filters by folder prefix", async () => {
    const bucket = await makeBucket((url) => {
      if ((url as string).includes("b2_list_file_names"))
        return Promise.resolve(makeResponse(JSON.stringify(B2_LIST_RESPONSE)));
      return Promise.resolve(makeResponse(null));
    });
    const requests: string[] = [];
    globalThis.fetch = withAuthMock((url) => {
      requests.push(url as string);
      if ((url as string).includes("b2_list_file_names"))
        return Promise.resolve(makeResponse(JSON.stringify(B2_LIST_RESPONSE)));
      return Promise.resolve(makeResponse(null));
    }) as typeof fetch;
    await bucket.folder("data").list();
    const listReq = requests.find((u) => u.includes("b2_list_file_names"));
    expect(listReq).toContain("prefix=data%2F");
  });
});

describe("B2 file().info()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns exists: true from a HEAD on the file", async () => {
    const bucket = await makeBucket((url, init) => {
      if ((url as string).includes("/file/") && init?.method === "HEAD")
        return Promise.resolve(
          makeResponse(null, 200, {
            "content-length": "5",
            "content-type": "text/plain",
            "x-bz-upload-timestamp": "1700000000000",
            "x-bz-file-id": "id123",
          }),
        );
      return Promise.resolve(makeResponse(null));
    });
    const info = await bucket.file("hello.txt").info();
    expect(info).not.toBeNull();
    expect(info!.type).toBe("text/plain");
    expect(info!.size).toBe(5);
    expect(info!.version).toBe("id123");
  });

  it("returns null when the HEAD 404s", async () => {
    const bucket = await makeBucket((url, init) => {
      if ((url as string).includes("/file/") && init?.method === "HEAD")
        return Promise.resolve(makeResponse(null, 404));
      return Promise.resolve(makeResponse(null));
    });
    expect(await bucket.file("nonexistent.txt").info()).toBeNull();
  });
});

describe("B2 file().exists()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns true when the HEAD succeeds", async () => {
    const bucket = await makeBucket((url, init) => {
      if ((url as string).includes("/file/") && init?.method === "HEAD")
        return Promise.resolve(makeResponse("hi", 200));
      return Promise.resolve(makeResponse(null));
    });
    expect(await bucket.file("hello.txt").exists()).toBe(true);
  });

  it("returns false when the HEAD 404s", async () => {
    const bucket = await makeBucket((url, init) => {
      if ((url as string).includes("/file/") && init?.method === "HEAD")
        return Promise.resolve(makeResponse(null, 404));
      return Promise.resolve(makeResponse(null));
    });
    expect(await bucket.file("missing.txt").exists()).toBe(false);
  });
});

describe("B2 large-file (chunked) upload", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Just over one 8 MiB part, so the chunker escalates into two parts
  const SIZE = 8 * 1024 * 1024 + 100;

  it("runs start → parts (with SHA1s) → finish", async () => {
    const calls: string[] = [];
    const partNumbers: string[] = [];
    let startBody: Record<string, unknown> | null = null;
    let finishBody: {
      fileId: string;
      partSha1Array: string[];
    } | null = null;

    const bucket = await makeBucket((url, init) => {
      const u = url as string;
      if (u.includes("b2_start_large_file")) {
        calls.push("start");
        startBody = JSON.parse(init?.body as string);
        return Promise.resolve(
          makeResponse(JSON.stringify({ fileId: "large-1" })),
        );
      }
      if (u.includes("b2_get_upload_part_url")) {
        return Promise.resolve(
          makeResponse(
            JSON.stringify({
              uploadUrl: "https://part.example/upload",
              authorizationToken: "part-token",
            }),
          ),
        );
      }
      if (u === "https://part.example/upload") {
        calls.push("part");
        const headers = Object.fromEntries(
          new Headers(init?.headers).entries(),
        );
        partNumbers.push(headers["x-bz-part-number"]);
        expect(headers["x-bz-content-sha1"]).toMatch(/^[0-9a-f]{40}$/);
        return Promise.resolve(makeResponse("{}"));
      }
      if (u.includes("b2_finish_large_file")) {
        calls.push("finish");
        finishBody = JSON.parse(init?.body as string);
        return Promise.resolve(makeResponse("{}"));
      }
      return Promise.resolve(makeResponse("{}"));
    });

    await bucket
      .file("big.bin")
      .write(Buffer.alloc(SIZE), { metadata: { check: "chunked" } });

    expect(calls).toEqual(["start", "part", "part", "finish"]);
    expect(partNumbers).toEqual(["1", "2"]);
    expect(startBody!.fileName).toBe("big.bin");
    expect((startBody!.fileInfo as Record<string, string>).check).toBe(
      "chunked",
    );
    expect(finishBody!.fileId).toBe("large-1");
    expect(finishBody!.partSha1Array).toHaveLength(2);
    expect(finishBody!.partSha1Array[0]).toMatch(/^[0-9a-f]{40}$/);
  });

  it("cancels the large file when a part fails", async () => {
    const calls: string[] = [];
    let cancelBody: { fileId: string } | null = null;
    let parts = 0;

    const bucket = await makeBucket((url, init) => {
      const u = url as string;
      if (u.includes("b2_start_large_file")) {
        calls.push("start");
        return Promise.resolve(
          makeResponse(JSON.stringify({ fileId: "large-2" })),
        );
      }
      if (u.includes("b2_get_upload_part_url")) {
        return Promise.resolve(
          makeResponse(
            JSON.stringify({
              uploadUrl: "https://part.example/upload",
              authorizationToken: "part-token",
            }),
          ),
        );
      }
      if (u === "https://part.example/upload") {
        parts++;
        if (parts === 2)
          return Promise.resolve(makeResponse("part failed", 500));
        return Promise.resolve(makeResponse("{}"));
      }
      if (u.includes("b2_cancel_large_file")) {
        calls.push("cancel");
        cancelBody = JSON.parse(init?.body as string);
        return Promise.resolve(makeResponse("{}"));
      }
      if (u.includes("b2_finish_large_file")) {
        calls.push("finish");
        return Promise.resolve(makeResponse("{}"));
      }
      return Promise.resolve(makeResponse("{}"));
    });

    let threw = false;
    try {
      await bucket.file("big.bin").write(Buffer.alloc(SIZE));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(calls).toEqual(["start", "cancel"]); // no finish
    expect(cancelBody!.fileId).toBe("large-2");
  });
});

describe("B2 file().write()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("requests upload URL then POSTs the file", async () => {
    const requests: { url: string; method: string }[] = [];
    const bucket = await makeBucket((url, init) => {
      requests.push({ url: url as string, method: init?.method ?? "GET" });
      if ((url as string).includes("b2_get_upload_url")) {
        return Promise.resolve(
          makeResponse(
            JSON.stringify({
              uploadUrl: "https://upload.backblazeb2.com/upload",
              authorizationToken: "upload-token",
            }),
          ),
        );
      }
      if ((url as string).includes("/upload")) {
        return Promise.resolve(
          makeResponse(JSON.stringify({ fileId: "new-file-id" })),
        );
      }
      return Promise.resolve(makeResponse(null));
    });

    await bucket.file("hello.txt").write("hello world");
    expect(requests.some((r) => r.url.includes("b2_get_upload_url"))).toBe(
      true,
    );
    const uploadReq = requests.find((r) => r.url.includes("/upload"));
    expect(uploadReq?.method).toBe("POST");
  });

  it("sends the correct B2 upload headers", async () => {
    let uploadHeaders: Record<string, string> = {};
    const bucket = await makeBucket((url, init) => {
      if ((url as string).includes("b2_get_upload_url")) {
        return Promise.resolve(
          makeResponse(
            JSON.stringify({
              uploadUrl: "https://upload.backblazeb2.com/upload",
              authorizationToken: "upload-token",
            }),
          ),
        );
      }
      if ((url as string).includes("/upload")) {
        uploadHeaders = Object.fromEntries(
          new Headers(init?.headers).entries(),
        );
        return Promise.resolve(
          makeResponse(JSON.stringify({ fileId: "new-id" })),
        );
      }
      return Promise.resolve(makeResponse(null));
    });

    await bucket.file("hello.txt").write("hello");
    expect(uploadHeaders["x-bz-file-name"]).toBe("hello.txt");
    expect(uploadHeaders["content-type"]).toBe("text/plain");
    expect(uploadHeaders["x-bz-content-sha1"]).toBeDefined();
  });

  it("detects content-type from the extension, like the other providers", async () => {
    let uploadHeaders: Record<string, string> = {};
    const bucket = await makeBucket((url, init) => {
      if ((url as string).includes("b2_get_upload_url")) {
        return Promise.resolve(
          makeResponse(
            JSON.stringify({
              uploadUrl: "https://upload.backblazeb2.com/upload",
              authorizationToken: "upload-token",
            }),
          ),
        );
      }
      if ((url as string).includes("/upload")) {
        uploadHeaders = Object.fromEntries(
          new Headers(init?.headers).entries(),
        );
        return Promise.resolve(
          makeResponse(JSON.stringify({ fileId: "new-id" })),
        );
      }
      return Promise.resolve(makeResponse(null));
    });

    await bucket.file("archive.gz").write("data");
    expect(uploadHeaders["content-type"]).toBe("application/gzip");
  });

  it("falls back to b2/x-auto for unknown extensions", async () => {
    let uploadHeaders: Record<string, string> = {};
    const bucket = await makeBucket((url, init) => {
      if ((url as string).includes("b2_get_upload_url")) {
        return Promise.resolve(
          makeResponse(
            JSON.stringify({
              uploadUrl: "https://upload.backblazeb2.com/upload",
              authorizationToken: "upload-token",
            }),
          ),
        );
      }
      if ((url as string).includes("/upload")) {
        uploadHeaders = Object.fromEntries(
          new Headers(init?.headers).entries(),
        );
        return Promise.resolve(
          makeResponse(JSON.stringify({ fileId: "new-id" })),
        );
      }
      return Promise.resolve(makeResponse(null));
    });

    await bucket.file("mystery-file-no-ext").write("data");
    expect(uploadHeaders["content-type"]).toBe("b2/x-auto");
  });
});

describe("B2 file().publicUrl()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds the URL from the bucket base once authenticated", async () => {
    const bucket = await makeBucket();
    expect(await bucket.file("hello.txt").publicUrl()).toBe(
      "https://f001.backblazeb2.com/file/test-bucket/hello.txt",
    );
  });

  it("returns a URL for files returned from list()", async () => {
    const bucket = await makeBucket((url) => {
      if ((url as string).includes("b2_list_file_names"))
        return Promise.resolve(makeResponse(JSON.stringify(B2_LIST_RESPONSE)));
      return Promise.resolve(makeResponse(null));
    });
    const files = await bucket.list();
    expect(await files[0].publicUrl()).toBe(
      "https://f001.backblazeb2.com/file/test-bucket/hello.txt",
    );
  });
});

describe("B2 file().signedUrl()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns a URL with authorization token", async () => {
    const bucket = await makeBucket((url) => {
      if ((url as string).includes("b2_get_download_authorization")) {
        return Promise.resolve(
          makeResponse(
            JSON.stringify({ authorizationToken: "signed-token-abc" }),
          ),
        );
      }
      return Promise.resolve(makeResponse(null));
    });
    const url = await bucket.file("hello.txt").signedUrl({ expires: 3600 });
    expect(url).toContain("Authorization=signed-token-abc");
    expect(url).toContain("/file/test-bucket/hello.txt");
  });

  it("accepts string duration", async () => {
    let capturedBody: Record<string, unknown> = {};
    const bucket = await makeBucket((url, init) => {
      if ((url as string).includes("b2_get_download_authorization")) {
        capturedBody = JSON.parse((init?.body as string) ?? "{}") as Record<
          string,
          unknown
        >;
        return Promise.resolve(
          makeResponse(JSON.stringify({ authorizationToken: "tok" })),
        );
      }
      return Promise.resolve(makeResponse(null));
    });
    await bucket.file("hello.txt").signedUrl({ expires: "30min" });
    expect(capturedBody["validDurationInSeconds"]).toBe(1800);
  });
});

describe("B2 file().uploadUrl()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null (B2 does not support presigned uploads)", async () => {
    const bucket = await makeBucket();
    expect(
      await bucket.file("hello.txt").uploadUrl({ expires: 3600 }),
    ).toBeNull();
  });
});

describe("B2 file().copyTo()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("downloads source and uploads to destination", async () => {
    const requests: string[] = [];
    const bucket = await makeBucket((url) => {
      requests.push(url as string);
      if ((url as string).includes("/file/"))
        return Promise.resolve(makeResponse("content"));
      if ((url as string).includes("b2_get_upload_url"))
        return Promise.resolve(
          makeResponse(
            JSON.stringify({
              uploadUrl: "https://upload.backblazeb2.com/upload",
              authorizationToken: "upload-token",
            }),
          ),
        );
      if ((url as string).includes("/upload"))
        return Promise.resolve(
          makeResponse(JSON.stringify({ fileId: "new-id" })),
        );
      return Promise.resolve(makeResponse(null));
    });
    await bucket.file("src.txt").copyTo("dst.txt");
    expect(requests.some((u) => u.includes("/file/"))).toBe(true);
    expect(requests.some((u) => u.includes("b2_get_upload_url"))).toBe(true);
    expect(requests.some((u) => u.includes("/upload"))).toBe(true);
  });
});

describe("B2 file().rename()", () => {
  it("throws when given a name with a slash", async () => {
    const originalFetch = globalThis.fetch;
    mockFetch(withAuthMock());
    const bucket = BackBlaze("test-bucket", {
      id: "test-id",
      secret: "test-key",
    });
    await expect(
      bucket.file("dir/old.txt").rename("sub/new.txt"),
    ).rejects.toThrow("rename() cannot change directory");
    globalThis.fetch = originalFetch;
  });
});

describe("B2 bucket.remove()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("hides every listed file and returns them", async () => {
    const hidden: string[] = [];
    const bucket = await makeBucket((url, init) => {
      if ((url as string).includes("b2_list_file_names")) {
        return Promise.resolve(makeResponse(JSON.stringify(B2_LIST_RESPONSE)));
      }
      if ((url as string).includes("b2_hide_file")) {
        const { fileName } = JSON.parse((init?.body as string) ?? "{}") as {
          fileName: string;
        };
        hidden.push(fileName);
        return Promise.resolve(makeResponse(JSON.stringify({ fileName })));
      }
      return Promise.resolve(makeResponse(null));
    });

    const deleted = await bucket.remove(/./);
    expect(deleted.length).toBe(2);
    expect(hidden.sort()).toEqual(["data/world.json", "hello.txt"]);
  });

  it("never destroys a version", async () => {
    // b2_delete_file_version would both drop the newest version and uncover
    // the one before it, which is the opposite of removing a path.
    const calls: string[] = [];
    const bucket = await makeBucket((url) => {
      const u = url as string;
      if (u.includes("b2_list_file_names"))
        return Promise.resolve(makeResponse(JSON.stringify(B2_LIST_RESPONSE)));
      if (u.includes("b2_")) calls.push(u.split("b2_").pop()!.split("?")[0]);
      return Promise.resolve(makeResponse("{}"));
    });
    await bucket.remove(/./);
    expect(calls).not.toContain("delete_file_version");
    expect(calls).not.toContain("list_file_versions");
  });

  it("hiding an already-hidden path is a no-op, not an error", async () => {
    let hides = 0;
    const bucket = await makeBucket((url) => {
      if ((url as string).includes("b2_hide_file")) {
        hides++;
        return Promise.resolve(
          makeResponse(
            JSON.stringify({
              status: 400,
              code: "file_not_present",
              message: "not present",
            }),
            400,
            { "content-type": "application/json" },
          ),
        );
      }
      return Promise.resolve(makeResponse("{}"));
    });
    const file = await bucket.file("gone.txt").remove();
    expect(file.path).toBe("gone.txt");
    expect(hides).toBe(1); // one attempt, no retry and no second marker
  });

  it("returns empty array when nothing to delete", async () => {
    const bucket = await makeBucket((url) => {
      if ((url as string).includes("b2_list_file_names"))
        return Promise.resolve(
          makeResponse(JSON.stringify({ files: [], nextFileName: null })),
        );
      return Promise.resolve(makeResponse(null));
    });
    const deleted = await bucket.remove(/./);
    expect(deleted).toEqual([]);
  });
});

describe("B2 file().moveTo()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("copies then deletes the original", async () => {
    const requests: string[] = [];
    const bucket = await makeBucket((url, init) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if ((url as string).includes("/file/"))
        return Promise.resolve(makeResponse("content"));
      if ((url as string).includes("b2_get_upload_url"))
        return Promise.resolve(
          makeResponse(
            JSON.stringify({
              uploadUrl: "https://upload.backblazeb2.com/upload",
              authorizationToken: "upload-token",
            }),
          ),
        );
      if ((url as string).includes("/upload"))
        return Promise.resolve(
          makeResponse(JSON.stringify({ fileId: "new-id" })),
        );
      if ((url as string).includes("b2_hide_file"))
        return Promise.resolve(
          makeResponse(JSON.stringify({ fileName: "src.txt" })),
        );
      return Promise.resolve(makeResponse(null));
    });
    await bucket.file("src.txt").moveTo("dst.txt");
    expect(requests.some((r) => r.includes("/upload"))).toBe(true);
    expect(requests.some((r) => r.includes("b2_hide_file"))).toBe(true);
    // The source is hidden, never deleted: a move keeps the history that
    // removing the same file would have kept.
    expect(requests.some((r) => r.includes("b2_delete_file_version"))).toBe(
      false,
    );
  });
});
