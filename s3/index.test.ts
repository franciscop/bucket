import S3 from "./index.ts";

// All tests use mocked fetch — no real credentials needed.
// Tests that require real AWS credentials are in the describe.skip block below.

const TEST_BUCKET = "test-bucket";
const TEST_CONFIG = { id: "test-id", secret: "test-secret", region: "us-east-1" };

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

const S3_LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>test-bucket</Name>
  <Prefix></Prefix>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>hello.txt</Key>
    <ETag>"abc123def456"</ETag>
    <Size>5</Size>
    <LastModified>2024-01-01T00:00:00.000Z</LastModified>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <Contents>
    <Key>data/world.json</Key>
    <ETag>"def456abc123"</ETag>
    <Size>25</Size>
    <LastModified>2024-01-02T00:00:00.000Z</LastModified>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
</ListBucketResult>`;

describe("S3 module structure", () => {
  it("is a factory function", () => {
    expect(typeof S3).toBe("function");
  });

  it("returns a bucket object with the right methods", () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    expect(typeof bucket.info).toBe("function");
    expect(typeof bucket.list).toBe("function");
    expect(typeof bucket.file).toBe("function");
  });

  it("bucket has a type property", () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    expect(bucket.type).toBe("S3");
  });

  it("file() returns a file object with the right methods", () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    const file = bucket.file("test.txt");
    expect(typeof file.info).toBe("function");
    expect(typeof file.exists).toBe("function");
    expect(typeof file.text).toBe("function");
    expect(typeof file.json).toBe("function");
    expect(typeof file.arrayBuffer).toBe("function");
    expect(typeof file.blob).toBe("function");
    expect(typeof file.bytes).toBe("function");
    expect(typeof file.write).toBe("function");
    expect(typeof file.remove).toBe("function");
    expect(typeof file.stream).toBe("function");
    expect(typeof file.nodeReadable).toBe("function");
    expect(typeof file.writable).toBe("function");
    expect(typeof file.nodeWritable).toBe("function");
  });

  it("file() sets correct name and path properties", () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    const file = bucket.file("path/to/file.txt");
    expect(file.name).toBe("file.txt");
    expect(file.path).toBe("path/to/file.txt");
  });

  it("file() throws when given no name", () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    expect(() => bucket.file("")).toThrow("No name");
  });
});

describe("S3 bucket info", () => {
  it("returns correct bucket info", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    const info = await bucket.info();
    expect(info.id).toBe("test-id");
    expect(info.name).toBe(TEST_BUCKET);
    expect(info.type).toBe("S3");
    expect(info.endpoint).toBeDefined();
  });

  it("uses the correct default endpoint format", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    const info = await bucket.info();
    expect(info.endpoint).toBe(
      `https://${TEST_BUCKET}.s3.us-east-1.amazonaws.com`,
    );
  });

  it("respects a custom endpoint", async () => {
    const bucket = S3(TEST_BUCKET, {
      ...TEST_CONFIG,
      endpoint: "https://custom.endpoint.com",
    });
    const info = await bucket.info();
    expect(info.endpoint).toBe("https://custom.endpoint.com");
  });
});

describe("S3 list()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses S3 XML list response correctly", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse(S3_LIST_XML)));

    const files = await bucket.list();
    expect(files.length).toBe(2);
  });

  it("returns correct file names", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse(S3_LIST_XML)));

    const files = await bucket.list();
    expect(files[0].name).toBe("hello.txt");
    expect(files[1].name).toBe("world.json");
  });

  it("returns correct file paths", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse(S3_LIST_XML)));

    const files = await bucket.list();
    expect(files[0].path).toBe("hello.txt");
    expect(files[1].path).toBe("data/world.json");
  });

  it("returns file objects with remove/write/read methods", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse(S3_LIST_XML)));

    const files = await bucket.list();
    expect(typeof files[0].remove).toBe("function");
    expect(typeof files[0].write).toBe("function");
    expect(typeof files[0].text).toBe("function");
  });

  it("handles empty bucket", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    const emptyXml = `<?xml version="1.0"?>
<ListBucketResult><Name>test</Name><IsTruncated>false</IsTruncated></ListBucketResult>`;
    mockFetch(() => Promise.resolve(makeResponse(emptyXml)));

    const files = await bucket.list();
    expect(files).toEqual([]);
  });

  it("throws on non-OK response", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse("AccessDenied", 403)));

    await expect(bucket.list()).rejects.toThrow("S3 list error: 403");
  });

  it("follows pagination across multiple pages", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    const page1 = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>token-page-2</NextContinuationToken>
  <Contents><Key>file-a.txt</Key></Contents>
  <Contents><Key>file-b.txt</Key></Contents>
</ListBucketResult>`;
    const page2 = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>file-c.txt</Key></Contents>
</ListBucketResult>`;

    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return Promise.resolve(makeResponse(requests.length === 1 ? page1 : page2));
    });

    const files = await bucket.list();
    expect(files.length).toBe(3);
    expect(files.map((f) => f.name)).toEqual(["file-a.txt", "file-b.txt", "file-c.txt"]);
    expect(requests.length).toBe(2);
    expect(requests[1]).toContain("continuation-token=token-page-2");
  });
});

describe("S3 file().info()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns exists: true for an existing file", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
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
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse(null, 404)));

    const info = await bucket.file("nonexistent.txt").info();
    expect(info.exists).toBe(false);
    expect(info.type).toBeNull();
    expect(info.size).toBe(0);
    expect(info.date).toBeNull();
    expect(info.url).toBeNull();
  });
});

describe("S3 file().exists()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns true for an existing file", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    mockFetch(() =>
      Promise.resolve(
        makeResponse(null, 200, {
          "content-type": "text/plain",
          "content-length": "5",
          "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT",
        }),
      ),
    );
    expect(await bucket.file("hello.txt").exists()).toBe(true);
  });

  it("returns false for a non-existing file", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse(null, 404)));
    expect(await bucket.file("nonexistent.txt").exists()).toBe(false);
  });
});

describe("S3 file().text()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns file content as a string", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse("hello world")));
    expect(await bucket.file("hello.txt").text()).toBe("hello world");
  });

  it("throws on non-OK response", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse("Not Found", 404)));
    await expect(bucket.file("missing.txt").text()).rejects.toThrow(
      "S3 GET error: 404",
    );
  });
});

describe("S3 file().json()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses and returns JSON content", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    mockFetch(() =>
      Promise.resolve(
        makeResponse('["John","Mary","Sarah"]', 200, {
          "content-type": "application/json",
        }),
      ),
    );
    const data = await bucket.file("people.json").json();
    expect(data).toEqual(["John", "Mary", "Sarah"]);
  });
});

describe("S3 file().buffer()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns file content as an ArrayBuffer", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse("hello")));
    const buf = await bucket.file("hello.txt").arrayBuffer();
    expect(buf instanceof ArrayBuffer).toBe(true);
    expect(new TextDecoder().decode(buf)).toBe("hello");
  });
});

describe("S3 file().bytes()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns file content as Uint8Array", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse("hello")));
    const bytes = await bucket.file("hello.txt").bytes();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes).toString("utf-8")).toBe("hello");
  });
});

describe("S3 file().write()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a PUT request with string content", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
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

  it("sends a PUT request with Buffer content", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    let capturedMethod: string | undefined;

    mockFetch((_, init) => {
      capturedMethod = init?.method;
      return Promise.resolve(makeResponse(null, 200));
    });

    const buf = Buffer.from("hello buffer");
    await bucket.file("hello.txt").write(buf);
    expect(capturedMethod).toBe("PUT");
  });

  it("sends a PUT request with Blob content", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    let capturedMethod: string | undefined;

    mockFetch((_, init) => {
      capturedMethod = init?.method;
      return Promise.resolve(makeResponse(null, 200));
    });

    const blob = new Blob(["hello blob"]);
    await bucket.file("hello.txt").write(blob);
    expect(capturedMethod).toBe("PUT");
  });

  it("throws on non-OK response", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse(null, 403)));
    await expect(bucket.file("hello.txt").write("data")).rejects.toThrow(
      "S3 PUT error: 403",
    );
  });
});

describe("S3 file().remove()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a DELETE request", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    let capturedMethod: string | undefined;

    mockFetch((_, init) => {
      capturedMethod = init?.method;
      return Promise.resolve(makeResponse(null, 204));
    });

    await bucket.file("hello.txt").remove();
    expect(capturedMethod).toBe("DELETE");
  });

  it("accepts 204 No Content as success", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse(null, 204)));
    await expect(bucket.file("hello.txt").remove()).resolves.toBeUndefined();
  });

  it("throws on error responses", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    mockFetch(() => Promise.resolve(makeResponse(null, 403)));
    await expect(bucket.file("hello.txt").remove()).rejects.toThrow(
      "S3 DELETE error: 403",
    );
  });
});

describe("S3 file().stream()", () => {
  it("returns a web ReadableStream", () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    const stream = bucket.file("hello.txt").stream();
    expect(stream).toBeInstanceOf(ReadableStream);
  });
});

describe("S3 file().nodeReadable()", () => {
  it("returns a Node.js readable stream", () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    const stream = bucket.file("hello.txt").nodeReadable();
    expect(typeof (stream as NodeJS.ReadableStream).pipe).toBe("function");
  });
});

describe("S3 file().writable()", () => {
  it("returns a web WritableStream", () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    const stream = bucket.file("hello.txt").writable();
    expect(stream).toBeInstanceOf(WritableStream);
  });
});

describe("S3 file().nodeWritable()", () => {
  it("returns a Node.js writable stream", () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    const stream = bucket.file("hello.txt").nodeWritable();
    expect(typeof (stream as NodeJS.WritableStream).write).toBe("function");
  });
});

describe("S3 bucket.remove()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a POST DeleteObjects request", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    const requests: { url: string; method: string }[] = [];

    mockFetch((url, init) => {
      requests.push({ url, method: init?.method ?? "" });
      if ((init?.method ?? "").toUpperCase() === "GET") {
        return Promise.resolve(makeResponse(S3_LIST_XML));
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
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);

    mockFetch((_, init) => {
      if ((init?.method ?? "").toUpperCase() !== "POST") {
        return Promise.resolve(makeResponse(S3_LIST_XML));
      }
      const deleted = `<DeleteResult><Deleted><Key>hello.txt</Key></Deleted><Deleted><Key>data/world.json</Key></Deleted></DeleteResult>`;
      return Promise.resolve(makeResponse(deleted));
    });

    const deleted = await bucket.remove();
    expect(deleted.map((f) => f.path)).toEqual(["hello.txt", "data/world.json"]);
  });

  it("returns empty array when no files match filter", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    const emptyXml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`;
    mockFetch(() => Promise.resolve(makeResponse(emptyXml)));

    const deleted = await bucket.remove(/\.nonexistent$/);
    expect(deleted).toEqual([]);
  });

  it("batches deletions across paginated list", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
    const page1 = `<?xml version="1.0"?>
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>tok</NextContinuationToken>
  <Contents><Key>a.txt</Key></Contents>
</ListBucketResult>`;
    const page2 = `<?xml version="1.0"?>
<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>b.txt</Key></Contents>
</ListBucketResult>`;

    let listCalls = 0;
    mockFetch((url, init) => {
      if ((init?.method ?? "GET").toUpperCase() !== "POST") {
        return Promise.resolve(makeResponse(++listCalls === 1 ? page1 : page2));
      }
      const deletedXml = `<DeleteResult><Deleted><Key>a.txt</Key></Deleted><Deleted><Key>b.txt</Key></Deleted></DeleteResult>`;
      return Promise.resolve(makeResponse(deletedXml));
    });

    const deleted = await bucket.remove();
    expect(deleted.length).toBe(2);
  });
});

describe("S3 file() pipe operations", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("can pipe a web stream to a writable and send PUT", async () => {
    const bucket = S3(TEST_BUCKET, TEST_CONFIG);
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

describe.skip("S3 (requires real credentials)", () => {
  const bucket = S3();

  it("can get bucket info", async () => {
    const info = await bucket.info();
    expect(typeof info.id).toBe("string");
    expect(info.type).toBe("S3");
  });

  it("can list files", async () => {
    const files = await bucket.list();
    expect(Array.isArray(files)).toBe(true);
  });

  it("can write and remove a file", async () => {
    const file = bucket.file("test-ts-integration.txt");
    await file.write("hello from TypeScript");
    expect(await file.exists()).toBe(true);
    const text = await file.text();
    expect(text).toBe("hello from TypeScript");
    await file.remove();
    expect(await file.exists()).toBe(false);
  }, 30000);
});
