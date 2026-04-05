interface Env {
  API_BACKEND_URL: string;
  PROXY_SHARED_SECRET: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);

  const backendUrl = env.API_BACKEND_URL.replace(/\/$/, "");
  const targetUrl = `${backendUrl}${url.pathname}${url.search}`;

  const headers = new Headers(request.headers);
  headers.set("X-Proxy-Secret", env.PROXY_SHARED_SECRET);
  headers.set(
    "CF-Connecting-IP",
    request.headers.get("CF-Connecting-IP") || ""
  );

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    // @ts-expect-error duplex needed for streaming request bodies
    init.duplex = "half";
  }

  const response = await fetch(targetUrl, init);
  const responseHeaders = new Headers(response.headers);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
};
