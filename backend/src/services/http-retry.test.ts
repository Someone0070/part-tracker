import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry, UpstreamRequestError } from "./http-retry.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchWithRetry", () => {
  it("retries transient responses and returns the successful response", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("", { status: calls < 3 ? 503 : 200 });
    };
    const response = await fetchWithRetry("https://example.invalid", {}, { attempts: 3, baseDelayMs: 1 });
    assert.equal(response.status, 200);
    assert.equal(calls, 3);
  });

  it("does not retry a non-transient provider rejection", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("bad image", { status: 400 });
    };
    const response = await fetchWithRetry("https://example.invalid", {}, { attempts: 3, baseDelayMs: 1 });
    assert.equal(response.status, 400);
    assert.equal(calls, 1);
  });

  it("turns a timed-out provider into a classified error", async () => {
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
    await assert.rejects(
      fetchWithRetry("https://example.invalid", {}, { attempts: 1, timeoutMs: 5 }),
      (error: unknown) => error instanceof UpstreamRequestError && error.code === "upstream_timeout",
    );
  });
});
