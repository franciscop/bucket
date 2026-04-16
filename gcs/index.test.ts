// This test only covers the things specific for this bucket;
// any shared API test is under test/index.test.ts at the root

import GCS, { GCSBucket } from "./index.ts";

// Generated test key (not a real credential)
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDMmVgEea01TKCJ
62JGsa3rAD+Af+gi2PI31oV+2Nt5BV5DkvwmrSQPFisGTQ8W7q6w0vMxObK75kVb
e7T0T0OYAKSMqgvocHDNIBURpdibBVQzvbCGcM3bf6qtGauiCP/bvbqkvUnvFyUR
m0xW/j04MK+9SsoYtx4ybKFJWfl/3n5kd3xyKAA1AjlMyEodkCn5SPZ4h28X3RYy
n6FWloCNibtZy5iGlh1Cm5wkYdc8Xbg6hsGgzozFjhwXqRZMFgT7riAw4HQjhTNm
HqJ4xhHp5Mxpb7qm9Fyst3/NiZF47PIXnnuKtvIOCxE892W60VshfOcuaiBPmZVu
kk5sj6HPAgMBAAECggEAP29l7lFJhkaBWfG8sT2CtmOHzNAbib5o7y4YitkyxwWG
kf3/JwC0tubBJT18KbiMOi/VjhQdGgwNwg0LcFopE3ZTjndkpMdD+h1x2txoWbwf
vMEZ+7z63ozpPq1AXUdcCOX8+fnkc/hhmmFjnG9MTOEvg8mt+lbASpMKuMLoTCAB
3yxotmAIno25RLykDB/VVFAN+tNbJOlhoOhB6ERqYIDM8vYplmV/48oiK0VS7bkK
uYbe1pUOo/7QEACtUQi6SCpYY4XWMrAeWtDke6YYey070lrhkd53tA7rmsfC8RwJ
FPh3YScXosM+fBGXRJ2va8XmR/it47NV8pI6eTQpdQKBgQD6tsc04CaZTSXmi+ih
4SyaZCsXUFRe47SfXbdxS+pwKeIaDNSifh7wXjPmkh7G5Cz8b65Tss/jXOTAZO1N
CXqy9YbbbVYaf5XV/19qcOxWU9oNp2guQ1s7BepxPVBONFPk83XBfRM4ZpD+B1X5
FwJ5/eKwOZdrK8fCHQuwzZC/uwKBgQDQ6alNIqk60/NHx8kDf29AycSs3uVSu/p4
1MuHIu1Kyq9dxkBV4i1HuU+TsDC67Kq1eSXRn8IIqTFfl/B2uSQwZ9lDSpvPKTtg
97YP5zZmr6PQQabxNq1J3C/EE75aXo7OX9BBCN1vtsxl+q+52tvf5G9CM8xg4yw0
+PEhkyUS/QKBgAk/Dm+7yJCk0L4E8OpvdIapJRGyC7qIKVQrT6WlCBtk4ArX6Eup
3Rg+USmyv+HT7njM4aACmzomZeVWk43gyJ6rAXM8QA2wIOWIiotRaNXyN7uDLgtu
voGZwUC14y1PLrzl4bTmGPxehABqYthR6ex32ZFoPlZcgfx9t72ohysbAoGAWhTX
BsayWAZ6eXIhMBvr+fDGmJAILDOYHjALjrq1vTFGitXoed/sDGhQcutfJ8rTFSsm
7ovHm/pwqrqWWmscuq6c1VI/ewVZcEd/vr3BDGgh57PXa11bPWTvR8oHo2nwg/Z2
kwRij0AwRKzixu4jLxiODOrO7twl/LV3LDYJn3UCgYBkewNip+LCLRJI8xV76rfi
fVsO3j7Wb0evG9WCek/VqHDLcysx/tBZJqZ23K/Mr1wHLLh2DiSCMk5gplTApg/Q
KMp6JQYjb7dsNUi7M4ZCvT7zstXKPUL/6+LMRwS5a2nJ+S2o6gZsN+f93VX7zc9S
SoAvCTxFFtEN3imi5sVcPg==
-----END PRIVATE KEY-----`;

const TEST_EMAIL = "test@test-project.iam.gserviceaccount.com";
const TEST_BUCKET = "test-bucket";

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

// Inject credentials via env vars before constructing a bucket in tests.
beforeEach(() => {
  process.env.GCS_CLIENT_EMAIL = TEST_EMAIL;
  process.env.GCS_PRIVATE_KEY = TEST_PRIVATE_KEY;
});

afterEach(() => {
  delete process.env.GCS_CLIENT_EMAIL;
  delete process.env.GCS_PRIVATE_KEY;
});

const GCS_LIST_RESPONSE = JSON.stringify({
  items: [
    { name: "hello.txt", contentType: "text/plain", size: "5", updated: "2024-01-01T00:00:00Z", mediaLink: "" },
    { name: "data/world.json", contentType: "application/json", size: "25", updated: "2024-01-02T00:00:00Z", mediaLink: "" },
  ],
});

describe("GCS module structure", () => {
  it("is a factory function", () => {
    expect(typeof GCS).toBe("function");
  });

  it("returns a bucket with the right methods", () => {
    const bucket = GCS(TEST_BUCKET);
    expect(typeof bucket.info).toBe("function");
    expect(typeof bucket.list).toBe("function");
    expect(typeof bucket.file).toBe("function");
    expect(typeof bucket.remove).toBe("function");
    expect(typeof bucket.count).toBe("function");
  });

  it("bucket has type GCS", () => {
    const bucket = GCS(TEST_BUCKET);
    expect(bucket.type).toBe("GCS");
  });

  it("file() returns a file object with the right methods", () => {
    const bucket = GCS(TEST_BUCKET);
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
    const bucket = GCS(TEST_BUCKET);
    const file = bucket.file("path/to/file.txt");
    expect(file.name).toBe("file.txt");
    expect(file.path).toBe("path/to/file.txt");
  });

  it("file() throws when given no name", () => {
    const bucket = GCS(TEST_BUCKET);
    expect(() => bucket.file("")).toThrow("No name");
  });
});

describe("GCS bucket.info()", () => {
  it("returns correct bucket info", async () => {
    const bucket = GCS(TEST_BUCKET);
    const info = await bucket.info();
    expect(info.id).toBe(TEST_BUCKET);
    expect(info.name).toBe(TEST_BUCKET);
    expect(info.type).toBe("GCS");
    expect(info.endpoint).toBe(`https://storage.googleapis.com/${TEST_BUCKET}`);
  });
});

describe("GCS bucket.list()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Mock token endpoint so accessToken() works without real credentials
    mockFetch((url) => {
      if (url.includes("oauth2.googleapis.com")) {
        return Promise.resolve(makeResponse(JSON.stringify({ access_token: "test-token" })));
      }
      return Promise.resolve(makeResponse(GCS_LIST_RESPONSE));
    });
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  it("parses GCS JSON list response", async () => {
    const bucket = GCS(TEST_BUCKET);
    const files = await bucket.list();
    expect(files.length).toBe(2);
  });

  it("returns correct file names and paths", async () => {
    const bucket = GCS(TEST_BUCKET);
    const files = await bucket.list();
    expect(files[0].name).toBe("hello.txt");
    expect(files[0].path).toBe("hello.txt");
    expect(files[1].name).toBe("world.json");
    expect(files[1].path).toBe("data/world.json");
  });

  it("handles empty bucket", async () => {
    const bucket = GCS(TEST_BUCKET);
    mockFetch((url) => {
      if (url.includes("oauth2")) return Promise.resolve(makeResponse(JSON.stringify({ access_token: "tok" })));
      return Promise.resolve(makeResponse(JSON.stringify({})));
    });
    const files = await bucket.list();
    expect(files).toEqual([]);
  });

  it("follows pagination via nextPageToken", async () => {
    const bucket = GCS(TEST_BUCKET);
    const page1 = JSON.stringify({ items: [{ name: "a.txt", contentType: "text/plain", size: "1", updated: "" }], nextPageToken: "tok2" });
    const page2 = JSON.stringify({ items: [{ name: "b.txt", contentType: "text/plain", size: "1", updated: "" }] });

    const requests: string[] = [];
    mockFetch((url) => {
      if (url.includes("oauth2")) return Promise.resolve(makeResponse(JSON.stringify({ access_token: "tok" })));
      requests.push(url);
      return Promise.resolve(makeResponse(requests.length === 1 ? page1 : page2));
    });

    const files = await bucket.list();
    expect(files.length).toBe(2);
    expect(files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
    expect(requests.length).toBe(2);
    expect(requests[1]).toContain("pageToken=tok2");
  });

  it("throws on non-OK response", async () => {
    const bucket = GCS(TEST_BUCKET);
    mockFetch((url) => {
      if (url.includes("oauth2")) return Promise.resolve(makeResponse(JSON.stringify({ access_token: "tok" })));
      return Promise.resolve(makeResponse("Forbidden", 403));
    });
    await expect(bucket.list()).rejects.toThrow("GCS list error: 403");
  });
});

describe("GCS file().publicUrl()", () => {
  it("returns the correct GCS URL", () => {
    const bucket = GCS(TEST_BUCKET);
    expect(bucket.file("path/to/file.txt").publicUrl()).toBe(
      `https://storage.googleapis.com/${TEST_BUCKET}/path/to/file.txt`,
    );
  });
});

describe("GCS file().signedUrl()", () => {
  it("returns a V4 presigned URL for GET", async () => {
    const bucket = GCS(TEST_BUCKET);
    const url = await bucket.file("photo.jpg").signedUrl({ expires: "1h" });
    expect(url).toContain("storage.googleapis.com");
    expect(url).toContain("X-Goog-Signature");
    expect(url).toContain("X-Goog-Expires=3600");
    expect(url).toContain("GOOG4-RSA-SHA256");
  });

  it("accepts string durations", async () => {
    const bucket = GCS(TEST_BUCKET);
    const url = await bucket.file("photo.jpg").signedUrl({ expires: "30min" });
    expect(url).toContain("X-Goog-Expires=1800");
  });
});

describe("GCS file().uploadUrl()", () => {
  it("returns a V4 presigned URL for PUT", async () => {
    const bucket = GCS(TEST_BUCKET);
    const url = await bucket.file("photo.jpg").uploadUrl({ expires: 3600 });
    expect(url).toContain("X-Goog-Signature");
    expect(url).toContain("X-Goog-Expires=3600");
  });
});

// Helper: mock fetch so oauth2 token exchange always succeeds, then delegate to handler
function withTokenMock(handler: FetchHandler = () => Promise.resolve(makeResponse(null))): FetchHandler {
  return (url, init) => {
    if ((url as string).includes("oauth2.googleapis.com")) {
      return Promise.resolve(makeResponse(JSON.stringify({ access_token: "test-token" })));
    }
    return handler(url as string, init);
  };
}

describe("GCS file().info()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("returns exists: true for an existing file", async () => {
    const bucket = GCS(TEST_BUCKET);
    globalThis.fetch = withTokenMock((url) => {
      if ((url as string).includes("/storage/v1/b/")) {
        return Promise.resolve(makeResponse(JSON.stringify({
          name: "hello.txt",
          contentType: "text/plain",
          size: "5",
          updated: "2024-01-01T00:00:00Z",
          mediaLink: "",
        })));
      }
      return Promise.resolve(makeResponse(null));
    }) as typeof fetch;

    const info = await bucket.file("hello.txt").info();
    expect(info.exists).toBe(true);
    expect(info.name).toBe("hello.txt");
    expect(info.type).toBe("text/plain");
    expect(info.size).toBe(5);
  });

  it("returns exists: false for a missing file (404)", async () => {
    const bucket = GCS(TEST_BUCKET);
    globalThis.fetch = withTokenMock(() =>
      Promise.resolve(makeResponse(null, 404)),
    ) as typeof fetch;

    const info = await bucket.file("nonexistent.txt").info();
    expect(info.exists).toBe(false);
    expect(info.type).toBeNull();
    expect(info.size).toBe(0);
    expect(info.date).toBeNull();
    expect(info.url).toBeNull();
  });
});

describe("GCS file().exists()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("returns true for an existing file", async () => {
    const bucket = GCS(TEST_BUCKET);
    globalThis.fetch = withTokenMock(() =>
      Promise.resolve(makeResponse(JSON.stringify({
        name: "hello.txt", contentType: "text/plain", size: "5", updated: "", mediaLink: "",
      }))),
    ) as typeof fetch;
    expect(await bucket.file("hello.txt").exists()).toBe(true);
  });

  it("returns false for a non-existing file", async () => {
    const bucket = GCS(TEST_BUCKET);
    globalThis.fetch = withTokenMock(() =>
      Promise.resolve(makeResponse(null, 404)),
    ) as typeof fetch;
    expect(await bucket.file("nonexistent.txt").exists()).toBe(false);
  });
});

describe("GCS file().text()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("returns file content as a string", async () => {
    const bucket = GCS(TEST_BUCKET);
    globalThis.fetch = withTokenMock(() =>
      Promise.resolve(makeResponse("hello world")),
    ) as typeof fetch;
    expect(await bucket.file("hello.txt").text()).toBe("hello world");
  });

  it("throws on non-OK response", async () => {
    const bucket = GCS(TEST_BUCKET);
    globalThis.fetch = withTokenMock(() =>
      Promise.resolve(makeResponse("Not Found", 404)),
    ) as typeof fetch;
    await expect(bucket.file("missing.txt").text()).rejects.toThrow("GCS GET error: 404");
  });
});

describe("GCS file().json()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("parses and returns JSON content", async () => {
    const bucket = GCS(TEST_BUCKET);
    globalThis.fetch = withTokenMock(() =>
      Promise.resolve(makeResponse('["John","Mary","Sarah"]', 200, { "content-type": "application/json" })),
    ) as typeof fetch;
    const data = await bucket.file("people.json").json();
    expect(data).toEqual(["John", "Mary", "Sarah"]);
  });
});

describe("GCS file().arrayBuffer()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("returns file content as ArrayBuffer", async () => {
    const bucket = GCS(TEST_BUCKET);
    globalThis.fetch = withTokenMock(() =>
      Promise.resolve(makeResponse("hello")),
    ) as typeof fetch;
    const buf = await bucket.file("hello.txt").arrayBuffer();
    expect(buf instanceof ArrayBuffer).toBe(true);
    expect(new TextDecoder().decode(buf)).toBe("hello");
  });
});

describe("GCS file().bytes()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("returns file content as Uint8Array", async () => {
    const bucket = GCS(TEST_BUCKET);
    globalThis.fetch = withTokenMock(() =>
      Promise.resolve(makeResponse("hello")),
    ) as typeof fetch;
    const bytes = await bucket.file("hello.txt").bytes();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes).toString("utf-8")).toBe("hello");
  });
});

describe("GCS file().write()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("sends a POST to the upload endpoint with string content", async () => {
    const bucket = GCS(TEST_BUCKET);
    let capturedMethod: string | undefined;
    let capturedUrl: string | undefined;
    let capturedBody: BodyInit | null | undefined;

    globalThis.fetch = withTokenMock((url, init) => {
      capturedMethod = init?.method;
      capturedUrl = url as string;
      capturedBody = init?.body;
      return Promise.resolve(makeResponse(null, 200));
    }) as typeof fetch;

    await bucket.file("hello.txt").write("hello world");
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toContain("uploadType=media");
    expect(capturedUrl).toContain("hello.txt");
    expect(capturedBody).toBe("hello world");
  });

  it("throws on non-OK response", async () => {
    const bucket = GCS(TEST_BUCKET);
    globalThis.fetch = withTokenMock(() =>
      Promise.resolve(makeResponse(null, 403)),
    ) as typeof fetch;
    await expect(bucket.file("hello.txt").write("data")).rejects.toThrow("GCS PUT error: 403");
  });
});

describe("GCS file().remove()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("sends a DELETE request", async () => {
    const bucket = GCS(TEST_BUCKET);
    let capturedMethod: string | undefined;
    globalThis.fetch = withTokenMock((_, init) => {
      capturedMethod = init?.method;
      return Promise.resolve(makeResponse(null, 204));
    }) as typeof fetch;
    await bucket.file("hello.txt").remove();
    expect(capturedMethod).toBe("DELETE");
  });

  it("accepts 204 No Content as success", async () => {
    const bucket = GCS(TEST_BUCKET);
    globalThis.fetch = withTokenMock(() =>
      Promise.resolve(makeResponse(null, 204)),
    ) as typeof fetch;
    await expect(bucket.file("hello.txt").remove()).resolves.toBeUndefined();
  });
});

describe("GCS file().stream()", () => {
  it("returns a web ReadableStream", () => {
    const bucket = GCS(TEST_BUCKET);
    expect(bucket.file("hello.txt").stream()).toBeInstanceOf(ReadableStream);
  });
});

describe("GCS file().nodeReadable()", () => {
  it("returns a Node.js readable stream", () => {
    const bucket = GCS(TEST_BUCKET);
    const stream = bucket.file("hello.txt").nodeReadable();
    expect(typeof (stream as NodeJS.ReadableStream).pipe).toBe("function");
  });
});

describe("GCS file().writable()", () => {
  it("returns a web WritableStream", () => {
    const bucket = GCS(TEST_BUCKET);
    expect(bucket.file("hello.txt").writable()).toBeInstanceOf(WritableStream);
  });
});

describe("GCS file().nodeWritable()", () => {
  it("returns a Node.js writable stream", () => {
    const bucket = GCS(TEST_BUCKET);
    const stream = bucket.file("hello.txt").nodeWritable();
    expect(typeof (stream as NodeJS.WritableStream).write).toBe("function");
  });
});

describe("GCS bucket.remove()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("deletes all listed files and returns them", async () => {
    const bucket = GCS(TEST_BUCKET);
    const methods: string[] = [];
    globalThis.fetch = withTokenMock((url, init) => {
      methods.push(init?.method ?? "GET");
      if ((init?.method ?? "GET") === "GET") {
        return Promise.resolve(makeResponse(GCS_LIST_RESPONSE));
      }
      return Promise.resolve(makeResponse(null, 204));
    }) as typeof fetch;

    const deleted = await bucket.remove();
    expect(deleted.length).toBe(2);
    expect(methods.filter((m) => m === "DELETE").length).toBe(2);
  });

  it("returns empty array when nothing matches", async () => {
    const bucket = GCS(TEST_BUCKET);
    globalThis.fetch = withTokenMock(() =>
      Promise.resolve(makeResponse(JSON.stringify({}))),
    ) as typeof fetch;
    expect(await bucket.remove(/\.nonexistent$/)).toEqual([]);
  });
});

describe("GCS file().blob()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("returns file content as a Blob", async () => {
    const bucket = GCS(TEST_BUCKET);
    globalThis.fetch = withTokenMock(() =>
      Promise.resolve(makeResponse("hello")),
    ) as typeof fetch;
    const blob = await bucket.file("hello.txt").blob();
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.text()).toBe("hello");
  });
});

describe("GCS file().copyTo()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("sends a POST to the copyTo endpoint", async () => {
    const bucket = GCS(TEST_BUCKET);
    let capturedMethod: string | undefined;
    let capturedUrl: string | undefined;
    globalThis.fetch = withTokenMock((url, init) => {
      capturedMethod = init?.method;
      capturedUrl = url as string;
      return Promise.resolve(makeResponse(null, 200));
    }) as typeof fetch;
    await bucket.file("src.txt").copyTo("dst.txt");
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toContain("copyTo");
    expect(capturedUrl).toContain("dst.txt");
  });
});

describe("GCS file().moveTo()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("copies then deletes the original", async () => {
    const bucket = GCS(TEST_BUCKET);
    const methods: string[] = [];
    globalThis.fetch = withTokenMock((_, init) => {
      methods.push(init?.method ?? "GET");
      return Promise.resolve(makeResponse(null, 204));
    }) as typeof fetch;
    await bucket.file("src.txt").moveTo("dst.txt");
    expect(methods).toContain("POST");
    expect(methods).toContain("DELETE");
  });
});

describe("GCS file().rename()", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("renames within the same directory", async () => {
    const bucket = GCS(TEST_BUCKET);
    const capturedUrls: string[] = [];
    globalThis.fetch = withTokenMock((url, init) => {
      capturedUrls.push(url as string);
      return Promise.resolve(makeResponse(null, 204));
    }) as typeof fetch;
    await bucket.file("dir/old.txt").rename("new.txt");
    expect(capturedUrls.some((u) => u.includes("dir%2Fnew.txt") || u.includes("dir/new.txt"))).toBe(true);
  });

  it("throws when given a name with a slash", async () => {
    const bucket = GCS(TEST_BUCKET);
    await expect(bucket.file("dir/old.txt").rename("sub/new.txt")).rejects.toThrow(
      "rename() cannot change directory",
    );
  });
});

describe("GCS bucket.count()", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = withTokenMock(() =>
      Promise.resolve(makeResponse(GCS_LIST_RESPONSE)),
    ) as typeof fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  it("returns the number of files", async () => {
    const bucket = GCS(TEST_BUCKET);
    expect(await bucket.count()).toBe(2);
  });
});

describe("GCS file().write() content types", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("sends a PUT request with Buffer content", async () => {
    const bucket = GCS(TEST_BUCKET);
    let capturedBody: BodyInit | null | undefined;
    globalThis.fetch = withTokenMock((_, init) => {
      capturedBody = init?.body;
      return Promise.resolve(makeResponse(null, 200));
    }) as typeof fetch;
    await bucket.file("hello.txt").write(Buffer.from("hello"));
    expect(capturedBody).toBeInstanceOf(Buffer);
  });

  it("sends a PUT request with Blob content", async () => {
    const bucket = GCS(TEST_BUCKET);
    let capturedBody: BodyInit | null | undefined;
    globalThis.fetch = withTokenMock((_, init) => {
      capturedBody = init?.body;
      return Promise.resolve(makeResponse(null, 200));
    }) as typeof fetch;
    await bucket.file("hello.txt").write(new Blob(["hello"]));
    expect(capturedBody).toBeInstanceOf(Buffer);
  });
});

describe("GCS async iteration", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("yields all files via for-await-of", async () => {
    const bucket = GCS(TEST_BUCKET);
    globalThis.fetch = withTokenMock(() =>
      Promise.resolve(makeResponse(GCS_LIST_RESPONSE)),
    ) as typeof fetch;
    const names: string[] = [];
    for await (const file of bucket) {
      names.push(file.name);
    }
    expect(names.sort()).toEqual(["hello.txt", "world.json"]);
  });
});
