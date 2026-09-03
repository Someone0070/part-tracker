let accessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;

// In-flight GET dedupe: concurrent identical GETs share one request
const inflightGets = new Map<string, Promise<unknown>>();

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export async function refreshAccessToken(): Promise<string | null> {
  try {
    const res = await fetch("/api/auth/refresh", { method: "POST" });
    if (!res.ok) {
      accessToken = null;
      return null;
    }
    const data = await res.json();
    accessToken = data.accessToken;
    return accessToken;
  } catch {
    accessToken = null;
    return null;
  }
}

function getRefreshedToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = refreshAccessToken().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();

  // Dedupe concurrent identical GET requests
  if (method === "GET") {
    const key = path;
    const inflight = inflightGets.get(key);
    if (inflight) return inflight as Promise<T>;

    const promise = apiInternal<T>(path, options).finally(() => {
      inflightGets.delete(key);
    });
    inflightGets.set(key, promise);
    return promise;
  }

  return apiInternal<T>(path, options);
}

export interface UploadOptions {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxAttempts?: number;
  uploadId?: string;
}

const uploadIds = new WeakMap<File, string>();

export function shouldRetryUpload(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function uploadOnce<T>(path: string, file: File, uploadId: string, options: UploadOptions): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("image", file, file.name);
    form.append("uploadId", uploadId);
    xhr.open("POST", path);
    // Covers a slow 10 MB mobile upload plus the backend's bounded OCR retries.
    xhr.timeout = options.timeoutMs ?? 150_000;
    if (accessToken) xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);

    const abort = () => xhr.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => options.signal?.removeEventListener("abort", abort);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        options.onProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    };
    xhr.onload = () => {
      cleanup();
      let body: Record<string, unknown> | undefined;
      try {
        const parsed: unknown = JSON.parse(xhr.responseText);
        body = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : undefined;
      } catch {
        body = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (!body) {
          reject(new ApiError(502, "The server returned an invalid upload response. Your photo is still selected"));
          return;
        }
        options.onProgress?.(100);
        resolve(body as T);
        return;
      }
      const message = typeof body?.error === "string" ? body.error : "Upload failed";
      reject(new ApiError(xhr.status, message, body));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new ApiError(0, "Connection lost while uploading. Your photo is still selected"));
    };
    xhr.ontimeout = () => {
      cleanup();
      reject(new ApiError(408, "Upload timed out. Your photo is still selected"));
    };
    xhr.onabort = () => {
      cleanup();
      reject(options.signal?.aborted
        ? new DOMException("Upload cancelled", "AbortError")
        : new ApiError(0, "Upload interrupted. Your photo is still selected"));
    };
    xhr.send(form);
  });
}

function retryDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    const abort = () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, 500 * 2 ** (attempt - 1));
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function apiUpload<T = unknown>(
  path: string,
  file: File,
  options: UploadOptions = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new ApiError(0, "You are offline. Reconnect and tap Retry; your photo is still selected");
  }

  const maxAttempts = options.maxAttempts ?? 2;
  const uploadId = options.uploadId ?? uploadIds.get(file) ?? crypto.randomUUID();
  uploadIds.set(file, uploadId);
  let refreshed = false;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await uploadOnce<T>(path, file, uploadId, options);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (error instanceof ApiError && error.status === 401 && !refreshed) {
        refreshed = true;
        const token = await getRefreshedToken();
        if (token) {
          attempt--;
          continue;
        }
      }
      lastError = error;
      const retryable = error instanceof ApiError && shouldRetryUpload(error.status) && error.retryable !== false;
      if (!retryable || attempt === maxAttempts || navigator.onLine === false) throw error;
      options.onProgress?.(0);
      await retryDelay(attempt, options.signal);
    }
  }
  throw lastError;
}

async function apiInternal<T>(
  path: string,
  options: RequestInit
): Promise<T> {
  const headers = new Headers(options.headers);
  if (accessToken) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }
  if (
    options.body &&
    typeof options.body === "string" &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }

  let res: Response;
  try {
    res = await fetch(path, { ...options, headers });
  } catch {
    throw new ApiError(0, "Cannot connect to server");
  }

  if (res.status === 401 && !path.includes("/api/auth/")) {
    const newToken = await getRefreshedToken();
    if (newToken) {
      headers.set("Authorization", `Bearer ${newToken}`);
      res = await fetch(path, { ...options, headers });
    }
  }

  if (!res.ok) {
    const text = await res.text();
    let message = "Request failed";
    let body: Record<string, unknown> | undefined;
    try {
      body = JSON.parse(text);
      message = typeof (body as any).error === "string" ? (body as any).error : message;
    } catch {
      if (text.includes("Cannot")) message = text.replace(/<[^>]*>/g, "").trim();
    }
    throw new ApiError(res.status, message, body);
  }

  return res.json();
}

export class ApiError extends Error {
  public errorType?: string;
  public vendor?: string;
  public domain?: string;
  public retryable?: boolean;
  public requestId?: string;

  constructor(
    public status: number,
    message: string,
    body?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiError";
    if (body) {
      this.errorType = typeof body.errorType === "string" ? body.errorType : undefined;
      this.vendor = typeof body.vendor === "string" ? body.vendor : undefined;
      this.domain = typeof body.domain === "string" ? body.domain : undefined;
      this.retryable = typeof body.retryable === "boolean" ? body.retryable : undefined;
      this.requestId = typeof body.requestId === "string" ? body.requestId : undefined;
    }
  }
}
