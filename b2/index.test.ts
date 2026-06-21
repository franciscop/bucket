// This test only covers the things specific for this bucket;
// any shared API test is under test/index.test.ts at the root

import BackBlaze, { BackBlazeInstance } from "./index.ts";

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
  allowed: { bucketId: "test-bucket-id" },
  authorizationToken: "test-auth-token",
  apiUrl: "https://api.backblazeb2.com",
  downloadUrl: "https://f001.backblazeb2.com",
};

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
async function makeBucket(handler?: FetchHandler): Promise<BackBlazeInstance> {
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
    expect(info.endpoint).toBe("https://f001.backblazeb2.com/");
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

  it("populates metadata (type, size, date, url)", async () => {
    const bucket = await makeBucket((url) => {
      if ((url as string).includes("b2_list_file_names"))
        return Promise.resolve(makeResponse(JSON.stringify(B2_LIST_RESPONSE)));
      return Promise.resolve(makeResponse(null));
    });
    const files = await bucket.list();
    expect(files[0].type).toBe("text/plain");
    expect(files[0].size).toBe(5);
    expect(files[0].date).toBeInstanceOf(Date);
    expect(files[0].url).toBe(
      "https://f001.backblazeb2.com/file/test-bucket/hello.txt",
    );
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

  it("filters by string prefix", async () => {
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
    await bucket.list("data/");
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

  it("returns exists: true for a listed file", async () => {
    const bucket = await makeBucket((url) => {
      if ((url as string).includes("b2_list_file_names"))
        return Promise.resolve(makeResponse(JSON.stringify(B2_LIST_RESPONSE)));
      return Promise.resolve(makeResponse(null));
    });
    const info = await bucket.file("hello.txt").info();
    expect(info.exists).toBe(true);
    expect(info.type).toBe("text/plain");
    expect(info.size).toBe(5);
  });

  it("returns exists: false when not in list", async () => {
    const bucket = await makeBucket((url) => {
      if ((url as string).includes("b2_list_file_names"))
        return Promise.resolve(
          makeResponse(JSON.stringify({ files: [], nextFileName: null })),
        );
      return Promise.resolve(makeResponse(null));
    });
    const info = await bucket.file("nonexistent.txt").info();
    expect(info.exists).toBe(false);
    expect(info.type).toBeNull();
    expect(info.size).toBe(0);
    expect(info.date).toBeNull();
    expect(info.url).toBeNull();
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

  it("returns true for a file in the listing", async () => {
    const bucket = await makeBucket((url) => {
      if ((url as string).includes("b2_list_file_names"))
        return Promise.resolve(makeResponse(JSON.stringify(B2_LIST_RESPONSE)));
      return Promise.resolve(makeResponse(null));
    });
    expect(await bucket.file("hello.txt").exists()).toBe(true);
  });

  it("returns false for a file not in the listing", async () => {
    const bucket = await makeBucket((url) => {
      if ((url as string).includes("b2_list_file_names"))
        return Promise.resolve(
          makeResponse(JSON.stringify({ files: [], nextFileName: null })),
        );
      return Promise.resolve(makeResponse(null));
    });
    expect(await bucket.file("missing.txt").exists()).toBe(false);
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
    expect(bucket.file("hello.txt").publicUrl()).toBe(
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
    expect(files[0].publicUrl()).toBe(
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

  it("deletes all listed files and returns them", async () => {
    const deleteRequests: string[] = [];
    const bucket = await makeBucket((url, init) => {
      if ((url as string).includes("b2_list_file_names")) {
        return Promise.resolve(makeResponse(JSON.stringify(B2_LIST_RESPONSE)));
      }
      if ((url as string).includes("b2_list_file_versions")) {
        // remove() asks for every version of one exact file
        const { prefix } = JSON.parse((init?.body as string) ?? "{}") as {
          prefix: string;
        };
        return Promise.resolve(
          makeResponse(
            JSON.stringify({
              files: [{ fileName: prefix, fileId: "v-" + prefix }],
              nextFileName: null,
            }),
          ),
        );
      }
      if ((url as string).includes("b2_delete_file_version")) {
        deleteRequests.push(url as string);
        return Promise.resolve(
          makeResponse(
            JSON.stringify({ fileId: "deleted", fileName: "deleted" }),
          ),
        );
      }
      return Promise.resolve(makeResponse(null));
    });

    const deleted = await bucket.remove();
    expect(deleted.length).toBe(2);
    expect(deleteRequests.length).toBe(2);
  });

  it("returns empty array when nothing to delete", async () => {
    const bucket = await makeBucket((url) => {
      if ((url as string).includes("b2_list_file_names"))
        return Promise.resolve(
          makeResponse(JSON.stringify({ files: [], nextFileName: null })),
        );
      return Promise.resolve(makeResponse(null));
    });
    const deleted = await bucket.remove();
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
      if ((url as string).includes("b2_list_file_versions"))
        return Promise.resolve(
          makeResponse(
            JSON.stringify({
              files: [{ fileName: "src.txt", fileId: "src-id" }],
              nextFileName: null,
            }),
          ),
        );
      if ((url as string).includes("b2_delete_file_version"))
        return Promise.resolve(
          makeResponse(
            JSON.stringify({ fileId: "src-id", fileName: "src.txt" }),
          ),
        );
      return Promise.resolve(makeResponse(null));
    });
    await bucket.file("src.txt").moveTo("dst.txt");
    expect(requests.some((r) => r.includes("/upload"))).toBe(true);
    expect(requests.some((r) => r.includes("b2_delete_file_version"))).toBe(
      true,
    );
  });
});
