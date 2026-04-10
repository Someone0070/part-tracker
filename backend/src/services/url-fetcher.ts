import { resolve4, resolve6 } from "node:dns/promises";
import type { ParsedCookie } from "./cookies.js";

export interface FetchResult {
  html: string;
  finalUrl: string;
  statusCode: number;
  redirected: boolean;
  loginDetected: boolean;
  captchaDetected: boolean;
}

// --- Config ---

const PAGE_TIMEOUT = parseInt(process.env.URL_FETCH_PAGE_TIMEOUT_MS || "15000", 10);

// --- SSRF protection ---

const dnsCache = new Map<string, { ips: string[]; ts: number }>();
const DNS_CACHE_TTL = 30_000;

function normalizeIp(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return mapped[1];
  return ip;
}

function isPrivateIp(raw: string): boolean {
  const ip = normalizeIp(raw);
  if (ip.startsWith("0.")) return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("127.")) return true;
  if (ip.startsWith("169.254.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith("100.")) {
    const second = parseInt(ip.split(".")[1]);
    if (second >= 64 && second <= 127) return true;
  }
  if (ip.startsWith("198.18.") || ip.startsWith("198.19.")) return true;
  if (ip.startsWith("240.")) return true;
  if (ip === "::1") return true;
  if (ip === "::") return true;
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  if (ip.startsWith("fe80")) return true;
  return false;
}

async function checkSsrf(url: URL): Promise<void> {
  if (url.protocol !== "https:") throw new Error("URL must use HTTPS");

  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("URL not allowed");
  }

  const cached = dnsCache.get(host);
  if (cached && Date.now() - cached.ts < DNS_CACHE_TTL) {
    if (cached.ips.some(isPrivateIp)) throw new Error("URL resolves to private IP");
    return;
  }

  let ips: string[] = [];
  try {
    const [v4, v6] = await Promise.allSettled([resolve4(host), resolve6(host)]);
    if (v4.status === "fulfilled") ips.push(...v4.value);
    if (v6.status === "fulfilled") ips.push(...v6.value);
  } catch {
    throw new Error("DNS resolution failed");
  }
  if (ips.length === 0) throw new Error("DNS resolution failed");

  dnsCache.set(host, { ips, ts: Date.now() });
  if (ips.some(isPrivateIp)) throw new Error("URL resolves to private IP");
}

function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(":")) return true;
  if (host.startsWith("[")) return true;
  return false;
}

export function validateUrlSyntax(urlString: string): URL {
  const url = new URL(urlString);
  if (url.protocol !== "https:") throw new Error("URL must use HTTPS");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("URL not allowed");
  }
  if (isIpLiteral(host)) throw new Error("URL not allowed");
  return url;
}

// --- Login/CAPTCHA detection ---

function detectLoginPage(html: string, url: string): boolean {
  if (/ap\/signin|\/signin|\/login/i.test(url)) return true;
  if (/identity\.ebay/i.test(url)) return true;
  const lower = html.toLowerCase();
  return lower.includes('id="ap_email"') ||
    lower.includes('id="signin-reg"') ||
    lower.includes('id="userid"');
}

function detectCaptcha(html: string): boolean {
  const lower = html.toLowerCase();
  return lower.includes("captcha") ||
    lower.includes("recaptcha") ||
    lower.includes("verify you are a human");
}

// --- Cookie header ---

function buildCookieHeader(cookies: ParsedCookie[], url: URL): string {
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  const isSecure = url.protocol === "https:";

  return cookies
    .filter((c) => {
      const domain = c.domain.replace(/^\./, "").toLowerCase();
      const domainMatch = host === domain || host.endsWith(`.${domain}`);
      if (!domainMatch) return false;
      if (!path.startsWith(c.path)) return false;
      if (c.secure && !isSecure) return false;
      if (c.expiry > 0 && c.expiry * 1000 < Date.now()) return false;
      return true;
    })
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/**
 * Check if the HTML response looks like a real server-rendered page
 * vs a JS-only shell that needs a browser to render.
 */
function isContentful(html: string): boolean {
  // If it has substantial text content, it's server-rendered
  const textContent = html.replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // At least 200 chars of text content after stripping tags/scripts
  if (textContent.length > 200) return true;

  // Check for SPA indicators with no content
  if (html.includes('id="root"') || html.includes('id="app"') || html.includes('id="__next"')) {
    // Has an SPA mount point -- only contentful if there's actual text
    return textContent.length > 100;
  }

  return false;
}

// --- HTTP fetch (primary) ---

async function httpFetch(url: string, cookies: ParsedCookie[]): Promise<FetchResult> {
  const parsedUrl = new URL(url);
  await checkSsrf(parsedUrl);

  const cookieHeader = buildCookieHeader(cookies, parsedUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cookie": cookieHeader,
      },
      redirect: "follow",
      signal: controller.signal,
    });

    const html = await response.text();
    const finalUrl = response.url;

    return {
      html,
      finalUrl,
      statusCode: response.status,
      redirected: finalUrl !== url,
      loginDetected: detectLoginPage(html, finalUrl),
      captchaDetected: detectCaptcha(html),
    };
  } finally {
    clearTimeout(timeout);
  }
}

// --- Playwright fetch (fallback for JS-heavy pages) ---

async function playwrightFetch(url: string, cookies: ParsedCookie[]): Promise<FetchResult> {
  let chromium;
  try {
    chromium = (await import("playwright-core")).chromium;
  } catch {
    throw Object.assign(new Error("Playwright not available. Install playwright-core for JS-heavy pages."), { type: "no_browser" });
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });

    const parsedUrl = new URL(url);
    await context.addCookies(cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.includeSubdomains ? (c.domain.startsWith(".") ? c.domain : `.${c.domain}`) : c.domain.replace(/^\./, ""),
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      expires: c.expiry > 0 ? c.expiry : undefined,
      sameSite: "Lax" as const,
    })));

    const page = await context.newPage();

    // SSRF interception
    await page.route("**/*", async (route) => {
      try {
        const reqUrl = new URL(route.request().url());
        await checkSsrf(reqUrl);
      } catch {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });

    const response = await page.goto(url, {
      waitUntil: "networkidle",
      timeout: PAGE_TIMEOUT,
    });

    await page.waitForTimeout(2000);

    const html = await page.content();
    const finalUrl = page.url();

    await context.close();

    return {
      html,
      finalUrl,
      statusCode: response?.status() ?? 0,
      redirected: finalUrl !== url,
      loginDetected: detectLoginPage(html, finalUrl),
      captchaDetected: detectCaptcha(html),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// --- Main fetch (HTTP first, Playwright fallback) ---

export async function fetchOrderPage(url: string, cookies: ParsedCookie[]): Promise<FetchResult> {
  // Try plain HTTP first
  try {
    console.log(`[Fetch] HTTP fetch: ${url}`);
    const result = await httpFetch(url, cookies);

    // If we got a real page, use it
    if (result.statusCode >= 200 && result.statusCode < 400 && isContentful(result.html)) {
      console.log(`[Fetch] HTTP success (${result.statusCode}, ${result.html.length} chars)`);
      return result;
    }

    // Login/CAPTCHA detected -- return as-is (no point trying Playwright)
    if (result.loginDetected || result.captchaDetected) {
      console.log(`[Fetch] HTTP got login/captcha, returning`);
      return result;
    }

    // Empty or JS-only shell -- try Playwright
    console.log(`[Fetch] HTTP response not contentful (${result.statusCode}, ${result.html.length} chars), trying Playwright`);
  } catch (err) {
    console.warn(`[Fetch] HTTP failed:`, err instanceof Error ? err.message : err);
  }

  // Fallback to Playwright
  try {
    console.log(`[Fetch] Playwright fetch: ${url}`);
    const result = await playwrightFetch(url, cookies);
    console.log(`[Fetch] Playwright success (${result.statusCode}, ${result.html.length} chars)`);
    return result;
  } catch (err) {
    if (err instanceof Error && err.message.includes("timeout")) {
      throw Object.assign(new Error("Page took too long to load"), { type: "timeout" });
    }
    throw Object.assign(new Error(err instanceof Error ? err.message : "Fetch failed"), { type: "network" });
  }
}

export async function closeBrowser(): Promise<void> {
  // No-op -- Playwright instances are now created per-request
}
