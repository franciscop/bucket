// This test only covers the things specific for this bucket;
// any shared API test is under test/index.test.ts at the root

import CloudflareR2 from "./index.ts";

// All tests use mocked fetch, no real credentials needed.

const TEST_ENDPOINT =
  "https://test-account.r2.cloudflarestorage.com/test-bucket";
const TEST_CONFIG = { id: "test-id", secret: "test-secret", region: "auto" };

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

const R2_LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>test-bucket</Name>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>hello.txt</Key>
    <Size>5</Size>
    <LastModified>2024-01-01T00:00:00.000Z</LastModified>
  </Contents>
  <Contents>
    <Key>data/world.json</Key>
    <Size>25</Size>
    <LastModified>2024-01-02T00:00:00.000Z</LastModified>
  </Contents>
</ListBucketResult>`;

describe("R2 bucket.info()", () => {
  it("returns correct bucket info", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    const info = await bucket.info();
    expect(info.id).toBe("test-id");
    expect(info.name).toBe("test-bucket");
    expect(info.type).toBe("R2");
    expect(info.endpoint).toBe(TEST_ENDPOINT);
  });
});

describe("R2 bucket.list()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses R2 XML list response correctly", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse(R2_LIST_XML)));
    const files = await bucket.list();
    expect(files.length).toBe(2);
  });

  it("returns correct file names and paths", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse(R2_LIST_XML)));
    const files = await bucket.list();
    expect(files[0].name).toBe("hello.txt");
    expect(files[0].path).toBe("hello.txt");
    expect(files[1].name).toBe("world.json");
    expect(files[1].path).toBe("data/world.json");
  });

  it("handles empty bucket", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    const emptyXml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`;
    mockFetch(() => Promise.resolve(makeResponse(emptyXml)));
    const files = await bucket.list();
    expect(files).toEqual([]);
  });

  it("throws on non-OK response", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse("AccessDenied", 403)));
    await expect(bucket.list()).rejects.toThrow("R2 list error: 403");
  });

  it("follows pagination across multiple pages", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    const page1 = `<?xml version="1.0"?>
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>token-page-2</NextContinuationToken>
  <Contents><Key>file-a.txt</Key></Contents>
  <Contents><Key>file-b.txt</Key></Contents>
</ListBucketResult>`;
    const page2 = `<?xml version="1.0"?>
<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>file-c.txt</Key></Contents>
</ListBucketResult>`;

    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return Promise.resolve(
        makeResponse(requests.length === 1 ? page1 : page2),
      );
    });

    const files = await bucket.list();
    expect(files.length).toBe(3);
    expect(files.map((f) => f.name)).toEqual([
      "file-a.txt",
      "file-b.txt",
      "file-c.txt",
    ]);
    expect(requests.length).toBe(2);
    expect(requests[1]).toContain("continuation-token=token-page-2");
  });
});

describe("R2 file().info()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns exists: true for an existing file", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    mockFetch(() =>
      Promise.resolve(
        makeResponse(null, 200, {
          "content-type": "text/plain",
          "content-length": "5",
          "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT",
        }),
      ),
    );
    const info = await bucket.file("hello.txt").info();
    expect(info.exists).toBe(true);
    expect(info.name).toBe("hello.txt");
    expect(info.type).toBe("text/plain");
    expect(info.size).toBe(5);
  });

  it("returns exists: false for a missing file (404)", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse(null, 404)));
    const info = await bucket.file("nonexistent.txt").info();
    expect(info.exists).toBe(false);
    expect(info.type).toBeNull();
    expect(info.size).toBe(0);
    expect(info.date).toBeNull();
    expect(info.url).toBeNull();
  });
});

describe("R2 file().exists()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns true for an existing file", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    mockFetch(() =>
      Promise.resolve(makeResponse(null, 200, { "content-length": "5" })),
    );
    expect(await bucket.file("hello.txt").exists()).toBe(true);
  });

  it("returns false for a non-existing file", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse(null, 404)));
    expect(await bucket.file("nonexistent.txt").exists()).toBe(false);
  });
});

describe("R2 file().text()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws on non-OK response", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse("Not Found", 404)));
    await expect(bucket.file("missing.txt").text()).rejects.toThrow(
      "R2 GET error: 404",
    );
  });
});

describe("R2 file().write()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a PUT request with string content", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    let capturedMethod: string | undefined;
    let capturedBody: BodyInit | null | undefined;

    mockFetch((_, init) => {
      capturedMethod = init?.method;
      capturedBody = init?.body;
      return Promise.resolve(makeResponse(null, 200));
    });

    await bucket.file("hello.txt").write("hello world");
    expect(capturedMethod).toBe("PUT");
    expect(capturedBody).toBe("hello world");
  });

  it("throws on non-OK response", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse(null, 403)));
    await expect(bucket.file("hello.txt").write("data")).rejects.toThrow(
      "R2 PUT error: 403",
    );
  });
});

describe("R2 file().remove()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a DELETE request", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    let capturedMethod: string | undefined;
    mockFetch((_, init) => {
      capturedMethod = init?.method;
      return Promise.resolve(makeResponse(null, 204));
    });
    await bucket.file("hello.txt").remove();
    expect(capturedMethod).toBe("DELETE");
  });

  it("accepts 204 No Content as success", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse(null, 204)));
    await expect(bucket.file("hello.txt").remove()).resolves.toBeUndefined();
  });

  it("throws on error responses", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse(null, 403)));
    await expect(bucket.file("hello.txt").remove()).rejects.toThrow(
      "R2 DELETE error: 403",
    );
  });
});

describe("R2 file().publicUrl()", () => {
  it("returns the correct URL", () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    const url = bucket.file("path/to/file.txt").publicUrl();
    expect(url).toBe(`${TEST_ENDPOINT}/path/to/file.txt`);
  });
});

describe("R2 file().signedUrl()", () => {
  it("returns a presigned GET URL", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    const url = await bucket.file("file.txt").signedUrl({ expires: 3600 });
    expect(url).toContain("X-Amz-Signature");
    expect(url).toContain("X-Amz-Expires=3600");
  });

  it("accepts string duration", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    const url = await bucket.file("file.txt").signedUrl({ expires: "30min" });
    expect(url).toContain("X-Amz-Expires=1800");
  });
});

describe("R2 file().uploadUrl()", () => {
  it("returns a presigned PUT URL", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    const url = await bucket.file("file.txt").uploadUrl({ expires: 3600 });
    expect(url).toContain("X-Amz-Signature");
    expect(url).toContain("X-Amz-Expires=3600");
  });
});

describe("R2 bucket.remove()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a POST DeleteObjects request", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    const requests: { url: string; method: string }[] = [];

    mockFetch((url, init) => {
      requests.push({ url, method: init?.method ?? "" });
      if ((init?.method ?? "").toUpperCase() !== "POST") {
        return Promise.resolve(makeResponse(R2_LIST_XML));
      }
      const deleted = `<DeleteResult><Deleted><Key>hello.txt</Key></Deleted><Deleted><Key>data/world.json</Key></Deleted></DeleteResult>`;
      return Promise.resolve(makeResponse(deleted));
    });

    const deleted = await bucket.remove();
    const deleteReq = requests.find((r) => r.url.includes("delete="));
    expect(deleteReq).toBeDefined();
    expect(deleted.length).toBe(2);
  });

  it("returns the deleted file objects", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    mockFetch((_, init) => {
      if ((init?.method ?? "").toUpperCase() !== "POST") {
        return Promise.resolve(makeResponse(R2_LIST_XML));
      }
      const deleted = `<DeleteResult><Deleted><Key>hello.txt</Key></Deleted><Deleted><Key>data/world.json</Key></Deleted></DeleteResult>`;
      return Promise.resolve(makeResponse(deleted));
    });

    const deleted = await bucket.remove();
    expect(deleted.map((f) => f.path)).toEqual([
      "hello.txt",
      "data/world.json",
    ]);
  });

  it("returns empty array when no files match filter", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    const emptyXml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`;
    mockFetch(() => Promise.resolve(makeResponse(emptyXml)));
    const deleted = await bucket.remove(/\.nonexistent$/);
    expect(deleted).toEqual([]);
  });
});

describe("R2 file().copyTo()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a PUT with x-amz-copy-source header", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    let capturedMethod: string | undefined;
    let capturedCopySource: string | undefined;
    mockFetch((_, init) => {
      capturedMethod = init?.method;
      capturedCopySource =
        new Headers(init?.headers).get("x-amz-copy-source") ?? undefined;
      return Promise.resolve(makeResponse(null, 200));
    });
    await bucket.file("src.txt").copyTo("dst.txt");
    expect(capturedMethod).toBe("PUT");
    expect(capturedCopySource).toContain("src.txt");
  });
});

describe("R2 file().moveTo()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("copies then deletes the original", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    const methods: string[] = [];
    mockFetch((_, init) => {
      methods.push(init?.method ?? "GET");
      return Promise.resolve(
        makeResponse(null, init?.method === "DELETE" ? 204 : 200),
      );
    });
    await bucket.file("src.txt").moveTo("dst.txt");
    expect(methods).toContain("PUT");
    expect(methods).toContain("DELETE");
  });
});

describe("R2 file().rename()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renames within the same directory", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    const capturedUrls: string[] = [];
    mockFetch((url, init) => {
      capturedUrls.push(url as string);
      return Promise.resolve(
        makeResponse(null, init?.method === "DELETE" ? 204 : 200),
      );
    });
    await bucket.file("dir/old.txt").rename("new.txt");
    expect(capturedUrls.some((u) => u.includes("dir/new.txt"))).toBe(true);
  });

  it("throws when given a name with a slash", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    await expect(
      bucket.file("dir/old.txt").rename("sub/new.txt"),
    ).rejects.toThrow("rename() cannot change directory");
  });
});

describe("R2 file() pipe operations", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("can pipe a web stream to writable and send PUT", async () => {
    const bucket = CloudflareR2(TEST_ENDPOINT, TEST_CONFIG);
    let capturedMethod: string | undefined;
    let capturedBody: Uint8Array | undefined;

    mockFetch((_, init) => {
      capturedMethod = init?.method;
      capturedBody = init?.body as Uint8Array;
      return Promise.resolve(makeResponse(null, 200));
    });

    const text = "streamed content";
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });

    await readable.pipeTo(bucket.file("out.txt").writable() as WritableStream);
    expect(capturedMethod).toBe("PUT");
    expect(Buffer.from(capturedBody!).toString("utf-8")).toBe(text);
  });
});
