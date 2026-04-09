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

async function refreshAccessToken(): Promise<string | null> {
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
    try {
      const body = JSON.parse(text);
      message = body.error || message;
    } catch {
      if (text.includes("Cannot")) message = text.replace(/<[^>]*>/g, "").trim();
    }
    throw new ApiError(res.status, message);
  }

  return res.json();
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}
