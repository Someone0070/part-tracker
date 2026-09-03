export interface FetchRetryOptions {
  attempts?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  baseDelayMs?: number;
}

export class UpstreamRequestError extends Error {
  constructor(
    message: string,
    public readonly code: "upstream_timeout" | "upstream_unavailable",
    public readonly status = 503,
  ) {
    super(message);
    this.name = "UpstreamRequestError";
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit,
  options: FetchRetryOptions = {},
): Promise<Response> {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const baseDelayMs = options.baseDelayMs ?? 300;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) throw options.signal.reason;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    try {
      const response = await fetch(input, { ...init, signal });
      if (!retryableStatus(response.status) || attempt === attempts) return response;
      await response.body?.cancel().catch(() => undefined);
      const wait = retryAfterMs(response) ?? baseDelayMs * 2 ** (attempt - 1);
      await delay(Math.min(wait, 5_000), options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      lastError = error;
      if (attempt === attempts) break;
      await delay(baseDelayMs * 2 ** (attempt - 1), options.signal);
    }
  }

  const timedOut = lastError instanceof DOMException && lastError.name === "TimeoutError";
  throw new UpstreamRequestError(
    timedOut ? "Image processing provider timed out" : "Image processing provider is unavailable",
    timedOut ? "upstream_timeout" : "upstream_unavailable",
    timedOut ? 504 : 503,
  );
}
