// This test only covers the things specific for this bucket;
// any shared API test is under test/index.test.ts at the root

import Azure from "./index.ts";

const TEST_ACCOUNT = "testaccount";
const TEST_CONTAINER = "testcontainer";
// 32-byte base64 key for testing
const TEST_KEY = Buffer.alloc(32).toString("base64");

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

const AZURE_LIST_XML = `<?xml version="1.0" encoding="utf-8"?>
<EnumerationResults>
  <Blobs>
    <Blob><Name>hello.txt</Name><Properties><Content-Length>5</Content-Length></Properties></Blob>
    <Blob><Name>data/world.json</Name><Properties><Content-Length>25</Content-Length></Properties></Blob>
  </Blobs>
  <NextMarker></NextMarker>
</EnumerationResults>`;

describe("Azure module structure", () => {
  it("is a factory function", () => {
    expect(typeof Azure).toBe("function");
  });

  it("returns a bucket with the right methods", () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    expect(typeof bucket.info).toBe("function");
    expect(typeof bucket.list).toBe("function");
    expect(typeof bucket.file).toBe("function");
    expect(typeof bucket.remove).toBe("function");
    expect(typeof bucket.count).toBe("function");
  });

  it("bucket has a type property", () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    expect(bucket.type).toBe("AZURE");
  });

  it("file() returns a file object with the right methods", () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
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
    expect(typeof file.copyTo).toBe("function");
    expect(typeof file.moveTo).toBe("function");
    expect(typeof file.rename).toBe("function");
    expect(typeof file.stream).toBe("function");
    expect(typeof file.nodeReadable).toBe("function");
    expect(typeof file.writable).toBe("function");
    expect(typeof file.nodeWritable).toBe("function");
    expect(typeof file.publicUrl).toBe("function");
    expect(typeof file.signedUrl).toBe("function");
    expect(typeof file.uploadUrl).toBe("function");
  });

  it("file() sets correct name and path", () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    const file = bucket.file("path/to/file.txt");
    expect(file.name).toBe("file.txt");
    expect(file.path).toBe("path/to/file.txt");
  });

  it("file() throws when given no name", () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    expect(() => bucket.file("")).toThrow("No name");
  });
});

describe("Azure bucket.info()", () => {
  it("returns correct bucket info", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    const info = await bucket.info();
    expect(info.id).toBe(TEST_ACCOUNT);
    expect(info.name).toBe(TEST_CONTAINER);
    expect(info.type).toBe("AZURE");
    expect(info.endpoint).toBe(
      `https://${TEST_ACCOUNT}.blob.core.windows.net/${TEST_CONTAINER}`,
    );
  });
});

describe("Azure bucket.list()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses Azure XML list response", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    mockFetch(() => Promise.resolve(makeResponse(AZURE_LIST_XML)));
    const files = await bucket.list();
    expect(files.length).toBe(2);
  });

  it("returns correct file names and paths", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    mockFetch(() => Promise.resolve(makeResponse(AZURE_LIST_XML)));
    const files = await bucket.list();
    expect(files[0].name).toBe("hello.txt");
    expect(files[0].path).toBe("hello.txt");
    expect(files[1].name).toBe("world.json");
    expect(files[1].path).toBe("data/world.json");
  });

  it("handles empty container", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    const emptyXml = `<?xml version="1.0"?><EnumerationResults><Blobs></Blobs><NextMarker></NextMarker></EnumerationResults>`;
    mockFetch(() => Promise.resolve(makeResponse(emptyXml)));
    const files = await bucket.list();
    expect(files).toEqual([]);
  });

  it("follows pagination via NextMarker", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    const page1 = `<?xml version="1.0"?><EnumerationResults><Blobs><Blob><Name>a.txt</Name></Blob></Blobs><NextMarker>marker-2</NextMarker></EnumerationResults>`;
    const page2 = `<?xml version="1.0"?><EnumerationResults><Blobs><Blob><Name>b.txt</Name></Blob></Blobs><NextMarker></NextMarker></EnumerationResults>`;

    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return Promise.resolve(
        makeResponse(requests.length === 1 ? page1 : page2),
      );
    });

    const files = await bucket.list();
    expect(files.length).toBe(2);
    expect(files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
    expect(requests.length).toBe(2);
    expect(requests[1]).toContain("marker=marker-2");
  });

  it("throws on non-OK response", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    mockFetch(() => Promise.resolve(makeResponse("AuthenticationFailed", 403)));
    await expect(bucket.list()).rejects.toThrow("Azure list error: 403");
  });
});

describe("Azure file().info()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns exists: true for an existing file", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
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
    expect(info.type).toBe("text/plain");
    expect(info.size).toBe(5);
  });

  it("returns exists: false for a missing file", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    mockFetch(() => Promise.resolve(makeResponse(null, 404)));
    const info = await bucket.file("missing.txt").info();
    expect(info.exists).toBe(false);
    expect(info.size).toBe(0);
    expect(info.type).toBeNull();
  });
});

describe("Azure file().write()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a PUT request with x-ms-blob-type header", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    let capturedMethod: string | undefined;
    let capturedHeaders: Record<string, string> = {};

    mockFetch((_, init) => {
      capturedMethod = init?.method;
      capturedHeaders = Object.fromEntries(
        new Headers(init?.headers).entries(),
      );
      return Promise.resolve(makeResponse(null, 201));
    });

    await bucket.file("hello.txt").write("hello world");
    expect(capturedMethod).toBe("PUT");
    expect(capturedHeaders["x-ms-blob-type"]).toBe("BlockBlob");
  });

  it("throws on non-OK response", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    mockFetch(() => Promise.resolve(makeResponse(null, 403)));
    await expect(bucket.file("hello.txt").write("data")).rejects.toThrow(
      "Azure PUT error: 403",
    );
  });
});

describe("Azure file().remove()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a DELETE request", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    let capturedMethod: string | undefined;
    mockFetch((_, init) => {
      capturedMethod = init?.method;
      return Promise.resolve(makeResponse(null, 202));
    });
    await bucket.file("hello.txt").remove();
    expect(capturedMethod).toBe("DELETE");
  });
});

describe("Azure file().publicUrl()", () => {
  it("returns the correct blob URL", () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    const url = bucket.file("path/to/file.txt").publicUrl();
    expect(url).toBe(
      `https://${TEST_ACCOUNT}.blob.core.windows.net/${TEST_CONTAINER}/path/to/file.txt`,
    );
  });
});

describe("Azure file().signedUrl()", () => {
  it("returns a URL with SAS parameters", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    const url = await bucket.file("file.txt").signedUrl({ expires: 3600 });
    expect(url).toContain(TEST_ACCOUNT);
    expect(url).toContain("sig=");
    expect(url).toContain("sp=r");
  });
});

describe("Azure file().uploadUrl()", () => {
  it("returns a URL with write SAS parameters", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    const url = await bucket.file("file.txt").uploadUrl({ expires: 3600 });
    expect(url).toContain("sig=");
    expect(url).toContain("sp=w");
  });
});

describe("Azure file().exists()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns true for an existing file", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    mockFetch(() =>
      Promise.resolve(makeResponse(null, 200, { "content-length": "5" })),
    );
    expect(await bucket.file("hello.txt").exists()).toBe(true);
  });

  it("returns false for a missing file", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    mockFetch(() => Promise.resolve(makeResponse(null, 404)));
    expect(await bucket.file("missing.txt").exists()).toBe(false);
  });
});

describe("Azure file().text()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns file content as a string", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    mockFetch(() => Promise.resolve(makeResponse("hello world")));
    expect(await bucket.file("hello.txt").text()).toBe("hello world");
  });

  it("throws on non-OK response", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    mockFetch(() => Promise.resolve(makeResponse("Not Found", 404)));
    await expect(bucket.file("missing.txt").text()).rejects.toThrow(
      "Azure GET error: 404",
    );
  });
});

describe("Azure file().json()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses and returns JSON content", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
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

describe("Azure file().arrayBuffer()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns file content as an ArrayBuffer", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    mockFetch(() => Promise.resolve(makeResponse("hello")));
    const buf = await bucket.file("hello.txt").arrayBuffer();
    expect(buf instanceof ArrayBuffer).toBe(true);
    expect(new TextDecoder().decode(buf)).toBe("hello");
  });
});

describe("Azure file().bytes()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns file content as Uint8Array", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    mockFetch(() => Promise.resolve(makeResponse("hello")));
    const bytes = await bucket.file("hello.txt").bytes();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes).toString("utf-8")).toBe("hello");
  });
});

describe("Azure file().blob()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns file content as a Blob", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    mockFetch(() => Promise.resolve(makeResponse("hello")));
    const blob = await bucket.file("hello.txt").blob();
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.text()).toBe("hello");
  });
});

describe("Azure file().copyTo()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a PUT with x-ms-copy-source header", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    let capturedMethod: string | undefined;
    let capturedCopySource: string | undefined;
    mockFetch((_, init) => {
      capturedMethod = init?.method;
      capturedCopySource =
        new Headers(init?.headers).get("x-ms-copy-source") ?? undefined;
      return Promise.resolve(makeResponse(null, 201));
    });
    await bucket.file("src.txt").copyTo("dst.txt");
    expect(capturedMethod).toBe("PUT");
    expect(capturedCopySource).toContain("src.txt");
  });
});

describe("Azure file().moveTo()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("copies then deletes the original", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    const methods: string[] = [];
    mockFetch((_, init) => {
      methods.push(init?.method ?? "GET");
      return Promise.resolve(
        makeResponse(null, init?.method === "DELETE" ? 202 : 201),
      );
    });
    await bucket.file("src.txt").moveTo("dst.txt");
    expect(methods).toContain("PUT");
    expect(methods).toContain("DELETE");
  });
});

describe("Azure file().rename()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renames within the same directory", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    const capturedUrls: string[] = [];
    mockFetch((url, init) => {
      capturedUrls.push(url as string);
      return Promise.resolve(
        makeResponse(null, init?.method === "DELETE" ? 202 : 201),
      );
    });
    await bucket.file("dir/old.txt").rename("new.txt");
    expect(capturedUrls.some((u) => u.includes("dir/new.txt"))).toBe(true);
  });

  it("throws when given a name with a slash", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    await expect(
      bucket.file("dir/old.txt").rename("sub/new.txt"),
    ).rejects.toThrow("rename() cannot change directory");
  });
});

describe("Azure file().stream()", () => {
  it("returns a web ReadableStream", () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    expect(bucket.file("hello.txt").stream()).toBeInstanceOf(ReadableStream);
  });
});

describe("Azure file().nodeReadable()", () => {
  it("returns a Node.js readable stream", () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    const stream = bucket.file("hello.txt").nodeReadable();
    expect(typeof (stream as NodeJS.ReadableStream).pipe).toBe("function");
  });
});

describe("Azure file().writable()", () => {
  it("returns a web WritableStream", () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    expect(bucket.file("hello.txt").writable()).toBeInstanceOf(WritableStream);
  });
});

describe("Azure file().nodeWritable()", () => {
  it("returns a Node.js writable stream", () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    const stream = bucket.file("hello.txt").nodeWritable();
    expect(typeof (stream as NodeJS.WritableStream).write).toBe("function");
  });
});

describe("Azure bucket.count()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the number of files", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    mockFetch(() => Promise.resolve(makeResponse(AZURE_LIST_XML)));
    expect(await bucket.count()).toBe(2);
  });
});

describe("Azure bucket.remove()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("deletes all listed files and returns them", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    const methods: string[] = [];
    mockFetch((_, init) => {
      methods.push(init?.method ?? "GET");
      if ((init?.method ?? "GET") === "GET")
        return Promise.resolve(makeResponse(AZURE_LIST_XML));
      return Promise.resolve(makeResponse(null, 202));
    });

    const deleted = await bucket.remove();
    expect(deleted.length).toBe(2);
    expect(methods.filter((m) => m === "DELETE").length).toBe(2);
  });

  it("returns empty array when nothing matches", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    const emptyXml = `<?xml version="1.0"?><EnumerationResults><Blobs></Blobs><NextMarker></NextMarker></EnumerationResults>`;
    mockFetch(() => Promise.resolve(makeResponse(emptyXml)));
    expect(await bucket.remove(/\.nonexistent$/)).toEqual([]);
  });
});

describe("Azure file().write() content types", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a PUT request with Buffer content", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    let capturedBody: BodyInit | null | undefined;
    mockFetch((_, init) => {
      capturedBody = init?.body;
      return Promise.resolve(makeResponse(null, 201));
    });
    await bucket.file("hello.txt").write(Buffer.from("hello"));
    expect(capturedBody).toBeInstanceOf(Buffer);
  });

  it("sends a PUT request with Blob content", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    let capturedBody: BodyInit | null | undefined;
    mockFetch((_, init) => {
      capturedBody = init?.body;
      return Promise.resolve(makeResponse(null, 201));
    });
    await bucket.file("hello.txt").write(new Blob(["hello"]));
    expect(capturedBody).toBeInstanceOf(Buffer);
  });
});

describe("Azure async iteration", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("yields all files via for-await-of", async () => {
    const bucket = Azure(TEST_ACCOUNT, TEST_CONTAINER, TEST_KEY);
    mockFetch(() => Promise.resolve(makeResponse(AZURE_LIST_XML)));
    const names: string[] = [];
    for await (const file of bucket) {
      names.push(file.name);
    }
    expect(names.sort()).toEqual(["hello.txt", "world.json"]);
  });
});
