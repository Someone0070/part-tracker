import { chromium, type Browser, type BrowserContext } from "playwright-core";
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

// --- Browser singleton ---

let browserInstance: Browser | null = null;
let launchPromise: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
const BROWSER_TTL = parseInt(process.env.URL_FETCH_BROWSER_TTL_MS || "300000", 10);
const PAGE_TIMEOUT = parseInt(process.env.URL_FETCH_PAGE_TIMEOUT_MS || "30000", 10);
const EXTRA_WAIT = parseInt(process.env.URL_FETCH_EXTRA_WAIT_MS || "2000", 10);

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (browserInstance) {
      await browserInstance.close().catch(() => {});
      browserInstance = null;
    }
  }, BROWSER_TTL);
}

async function getBrowser(): Promise<Browser> {
  if (idleTimer) clearTimeout(idleTimer);
  if (browserInstance?.isConnected()) {
    resetIdleTimer();
    return browserInstance;
  }
  if (launchPromise) return launchPromise;
  launchPromise = chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  }).then((b) => {
    browserInstance = b;
    launchPromise = null;
    resetIdleTimer();
    return b;
  }).catch((err) => {
    launchPromise = null;
    throw err;
  });
  return launchPromise;
}

// --- SSRF protection ---

const dnsCache = new Map<string, { ips: string[]; ts: number }>();
const DNS_CACHE_TTL = 30_000;

function normalizeIp(ip: string): string {
  // Convert IPv4-mapped IPv6 (::ffff:10.0.0.1) to plain IPv4
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return mapped[1];
  return ip;
}

function isPrivateIp(raw: string): boolean {
  const ip = normalizeIp(raw);

  // IPv4 ranges
  if (ip.startsWith("0.")) return true;           // 0.0.0.0/8
  if (ip.startsWith("10.")) return true;           // 10.0.0.0/8
  if (ip.startsWith("127.")) return true;          // 127.0.0.0/8
  if (ip.startsWith("169.254.")) return true;      // link-local
  if (ip.startsWith("192.168.")) return true;      // 192.168.0.0/16
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1]);
    if (second >= 16 && second <= 31) return true;  // 172.16.0.0/12
  }
  if (ip.startsWith("100.")) {
    const second = parseInt(ip.split(".")[1]);
    if (second >= 64 && second <= 127) return true;  // 100.64.0.0/10 (CGNAT/cloud metadata)
  }
  if (ip.startsWith("198.18.") || ip.startsWith("198.19.")) return true;  // benchmark
  if (ip.startsWith("240.")) return true;           // reserved

  // IPv6 ranges
  if (ip === "::1") return true;                    // loopback
  if (ip === "::") return true;                     // unspecified
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;  // unique local
  if (ip.startsWith("fe80")) return true;           // link-local

  return false;
}

async function isAllowedUrl(url: URL): Promise<boolean> {
  if (url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return false;
  }

  const cached = dnsCache.get(host);
  if (cached && Date.now() - cached.ts < DNS_CACHE_TTL) {
    return !cached.ips.some(isPrivateIp);
  }

  let ips: string[] = [];
  try {
    const [v4, v6] = await Promise.allSettled([resolve4(host), resolve6(host)]);
    if (v4.status === "fulfilled") ips.push(...v4.value);
    if (v6.status === "fulfilled") ips.push(...v6.value);
  } catch {
    return false;
  }
  if (ips.length === 0) return false;

  dnsCache.set(host, { ips, ts: Date.now() });
  return !ips.some(isPrivateIp);
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
  if (isIpLiteral(host)) {
    throw new Error("URL not allowed");
  }
  return url;
}

// --- Cookie injection ---

function toPlaywrightCookies(cookies: ParsedCookie[], _url: string) {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.includeSubdomains ? (c.domain.startsWith(".") ? c.domain : `.${c.domain}`) : c.domain.replace(/^\./, ""),
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expires: c.expiry > 0 ? c.expiry : undefined,
    sameSite: "Lax" as const,
  }));
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

// --- Main fetch ---

export async function fetchOrderPage(url: string, cookies: ParsedCookie[]): Promise<FetchResult> {
  const browser = await getBrowser();
  let context: BrowserContext | null = null;

  try {
    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });

    await context.addCookies(toPlaywrightCookies(cookies, url));
    const page = await context.newPage();

    // SSRF interception
    await page.route("**/*", async (route) => {
      try {
        const reqUrl = new URL(route.request().url());
        if (!(await isAllowedUrl(reqUrl))) {
          await route.abort("blockedbyclient");
          return;
        }
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

    await page.waitForTimeout(EXTRA_WAIT);

    const html = await page.content();
    const finalUrl = page.url();

    return {
      html,
      finalUrl,
      statusCode: response?.status() ?? 0,
      redirected: finalUrl !== url,
      loginDetected: detectLoginPage(html, finalUrl),
      captchaDetected: detectCaptcha(html),
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes("timeout")) {
      throw Object.assign(new Error("Page took too long to load"), { type: "timeout" });
    }
    throw Object.assign(new Error(err instanceof Error ? err.message : "Fetch failed"), { type: "network" });
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

export async function closeBrowser(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}
