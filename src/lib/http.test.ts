// The one path every provider request takes, so the retry policy and the
// error shape are asserted here rather than seven times.
import BucketError from "./BucketError.ts";
import { Http, checkStatus } from "./http.ts";
import { makeResponse, mockFetch, restoreFetch } from "../../test/helpers.ts";

const http = (retries?: number) =>
  new Http({
    provider: "TEST",
    authorize: (req) => ({
      ...req,
      headers: { ...req.headers, Authorization: "signed" },
    }),
    ...(retries === undefined ? {} : { retries }),
  });

const codeOf = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
};

describe("Http.send", () => {
  restoreFetch();

  it("authorizes every request", async () => {
    let seen: Record<string, string> = {};
    mockFetch((_url, init) => {
      seen = init?.headers as Record<string, string>;
      return Promise.resolve(makeResponse("ok"));
    });
    await http().send("GET", "https://example.com/a");
    expect(seen.Authorization).toBe("signed");
  });

  it("turns a bad status into a BucketError with the provider and status", async () => {
    mockFetch(() => Promise.resolve(makeResponse("nope", 403)));
    let err: any;
    try {
      await http().send("GET", "https://example.com/a", { what: "GET" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BucketError);
    expect(err.status).toBe(403);
    expect(err.provider).toBe("TEST");
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toContain("TEST GET error: 403");
  });

  it("accepts the statuses a caller allows", async () => {
    mockFetch(() => Promise.resolve(makeResponse(null, 404)));
    const res = await http().send("DELETE", "https://example.com/a", {
      ok: [404],
    });
    expect(res.status).toBe(404);
  });

  it("returns any status when raw is set", async () => {
    mockFetch(() => Promise.resolve(makeResponse("boom", 500)));
    const res = await http(0).send("GET", "https://example.com/a", {
      raw: true,
    });
    expect(res.status).toBe(500);
  });
});

describe("Http retries", () => {
  restoreFetch();

  it("retries a 503 and succeeds", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return Promise.resolve(
        calls < 3 ? makeResponse("busy", 503) : makeResponse("ok"),
      );
    });
    const res = await http().send("GET", "https://example.com/a");
    expect(await res.text()).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up after the configured attempts, surfacing the last status", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return Promise.resolve(makeResponse("busy", 503));
    });
    expect(
      await codeOf(() => http(1).send("GET", "https://example.com/a")),
    ).toBe("UNKNOWN");
    expect(calls).toBe(2); // the first try plus one retry
  });

  it("retries a network failure", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      if (calls === 1) return Promise.reject(new TypeError("network down"));
      return Promise.resolve(makeResponse("ok"));
    });
    const res = await http().send("GET", "https://example.com/a");
    expect(await res.text()).toBe("ok");
    expect(calls).toBe(2);
  });

  it("does not retry a 4xx, which will fail again the same way", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return Promise.resolve(makeResponse("nope", 403));
    });
    await codeOf(() => http().send("GET", "https://example.com/a"));
    expect(calls).toBe(1);
  });

  it("does not retry a POST, which may not be replayable", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return Promise.resolve(makeResponse("busy", 503));
    });
    await codeOf(() => http().send("POST", "https://example.com/a"));
    expect(calls).toBe(1);
  });

  it("never retries an abort, however transient it looks", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return Promise.resolve(makeResponse("busy", 503));
    });
    expect(
      await codeOf(() =>
        http().send("GET", "https://example.com/a", {
          signal: AbortSignal.abort(),
        }),
      ),
    ).toBe("ABORTED");
    expect(calls).toBe(0);
  });
});

describe("checkStatus", () => {
  it("passes 2xx and the allowed statuses through", () => {
    const ok = makeResponse("a", 204);
    expect(checkStatus(ok, "TEST", "GET")).toBe(ok);
    const gone = makeResponse(null, 404);
    expect(checkStatus(gone, "TEST", "DELETE", 404)).toBe(gone);
  });

  it("maps the status onto a code", () => {
    for (const [status, code] of [
      [404, "NOT_FOUND"],
      [401, "UNAUTHORIZED"],
      [403, "FORBIDDEN"],
      [409, "CONFLICT"],
    ] as const) {
      try {
        checkStatus(makeResponse(null, status), "TEST", "GET");
        throw new Error("should have thrown");
      } catch (err) {
        expect(`${status}: ${(err as BucketError).code}`).toBe(
          `${status}: ${code}`,
        );
      }
    }
  });
});
