import { afterEach, describe, expect, it, vi } from "vitest";
import { apiUpload, shouldRetryUpload } from "./client";

type Outcome = { status: number; body?: Record<string, unknown>; rawBody?: string } | { event: "error" | "timeout" };

class FakeXhr {
  static outcomes: Outcome[] = [];
  static instances: FakeXhr[] = [];
  static uploadIds: string[] = [];
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  timeout = 0;
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  headers = new Map<string, string>();

  constructor() { FakeXhr.instances.push(this); }
  open() {}
  setRequestHeader(name: string, value: string) { this.headers.set(name, value); }
  abort() { this.onabort?.(); }
  send(body: FormData) {
    expect(body.get("image")).toBeInstanceOf(File);
    FakeXhr.uploadIds.push(String(body.get("uploadId")));
    const outcome = FakeXhr.outcomes.shift();
    if (!outcome) throw new Error("missing fake outcome");
    queueMicrotask(() => {
      if ("event" in outcome) {
        this[outcome.event === "error" ? "onerror" : "ontimeout"]?.();
        return;
      }
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
      this.status = outcome.status;
      this.responseText = outcome.rawBody ?? JSON.stringify(outcome.body ?? {});
      this.onload?.();
    });
  }
}

afterEach(() => {
  FakeXhr.outcomes = [];
  FakeXhr.instances = [];
  FakeXhr.uploadIds = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("image upload transport", () => {
  it("classifies transient HTTP statuses", () => {
    expect([0, 408, 429, 500, 503].every(shouldRetryUpload)).toBe(true);
    expect([400, 401, 404, 422].some(shouldRetryUpload)).toBe(false);
  });

  it("sends multipart bytes, reports progress, and retries transient failures", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    vi.stubGlobal("navigator", { onLine: true });
    FakeXhr.outcomes = [
      { status: 503, body: { error: "temporary", retryable: true } },
      { status: 200, body: { partNumber: "WP123456" } },
    ];
    const progress: number[] = [];
    const result = await apiUpload<{ partNumber: string }>(
      "/api/parts/ocr",
      new File(["jpeg"], "part.jpg", { type: "image/jpeg" }),
      { onProgress: (value) => progress.push(value), maxAttempts: 2 },
    );
    expect(result.partNumber).toBe("WP123456");
    expect(FakeXhr.instances).toHaveLength(2);
    expect(new Set(FakeXhr.uploadIds).size).toBe(1);
    expect(progress).toContain(50);
    expect(progress[progress.length - 1]).toBe(100);
  });

  it("fails immediately while offline and never starts a request", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    vi.stubGlobal("navigator", { onLine: false });
    await expect(apiUpload("/api/parts/ocr", new File(["jpeg"], "part.jpg", { type: "image/jpeg" })))
      .rejects.toThrow(/offline/i);
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it("retries when a successful HTTP response contains malformed JSON", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    vi.stubGlobal("navigator", { onLine: true });
    FakeXhr.outcomes = [
      { status: 200, rawBody: "not-json" },
      { status: 200, body: { partNumber: "W101" } },
    ];
    const result = await apiUpload<{ partNumber: string }>(
      "/api/parts/ocr",
      new File(["jpeg"], "part.jpg", { type: "image/jpeg" }),
      { maxAttempts: 2 },
    );
    expect(result.partNumber).toBe("W101");
    expect(FakeXhr.instances).toHaveLength(2);
  });

  it("honors caller cancellation", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    vi.stubGlobal("navigator", { onLine: true });
    FakeXhr.outcomes = [{ status: 200, body: {} }];
    const controller = new AbortController();
    const pending = apiUpload("/api/parts/ocr", new File(["jpeg"], "part.jpg", { type: "image/jpeg" }), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
