import { encrypt, decrypt } from "./crypto.js";

export interface ParsedCookie {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  expiry: number;
  name: string;
  value: string;
  httpOnly: boolean;
}

export function parseCookiesTxt(content: string): ParsedCookie[] {
  const cookies: ParsedCookie[] = [];
  for (const line of content.split("\n")) {
    let trimmed = line.trim();
    if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("#HttpOnly_"))) continue;

    let httpOnly = false;
    if (trimmed.startsWith("#HttpOnly_")) {
      httpOnly = true;
      trimmed = trimmed.slice("#HttpOnly_".length);
    }

    const parts = trimmed.split("\t");
    if (parts.length < 7) continue;

    cookies.push({
      domain: parts[0],
      includeSubdomains: parts[1].toUpperCase() === "TRUE",
      path: parts[2],
      secure: parts[3].toUpperCase() === "TRUE",
      expiry: parseInt(parts[4], 10) || 0,
      name: parts[5],
      value: parts[6],
      httpOnly,
    });
  }
  return cookies;
}

export function matchesDomain(urlHostname: string, storedDomain: string): boolean {
  const host = urlHostname.toLowerCase().replace(/^www\./, "");
  const domain = storedDomain.toLowerCase().replace(/^www\./, "");
  return host === domain || host.endsWith(`.${domain}`);
}

interface VendorCookieRow {
  domain: string;
  [key: string]: unknown;
}

export function resolveVendorCookies<T extends VendorCookieRow>(
  urlHostname: string,
  rows: T[],
): T | null {
  const host = urlHostname.toLowerCase().replace(/^www\./, "");
  const matches = rows.filter((r) => matchesDomain(host, r.domain));
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.domain.length - a.domain.length)[0];
}

const AUTH_COOKIE_PATTERNS: Record<string, RegExp[]> = {
  "amazon.com": [/^session-id$/i, /^at-main$/i, /^sess-at-/i, /^x-main$/i, /^ubid-main$/i],
  "ebay.com": [/^ebay$/i, /^nonsession$/i, /^ds1$/i, /^s$/i],
};
const GENERIC_AUTH_PATTERNS = [/session/i, /auth/i, /token/i, /sid/i, /login/i];

function isAuthCookie(name: string, vendorDomain: string): boolean {
  const vendorPatterns = AUTH_COOKIE_PATTERNS[vendorDomain];
  if (vendorPatterns) return vendorPatterns.some((p) => p.test(name));
  return GENERIC_AUTH_PATTERNS.some((p) => p.test(name));
}

export function getAuthCookieExpiry(cookies: ParsedCookie[], vendorDomain: string): Date | null {
  let earliest: number | null = null;
  for (const c of cookies) {
    if (c.expiry === 0) continue;
    if (!isAuthCookie(c.name, vendorDomain)) continue;
    if (earliest === null || c.expiry < earliest) earliest = c.expiry;
  }
  return earliest !== null ? new Date(earliest * 1000) : null;
}

export function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^\./, "").replace(/^www\./, "");
}

/**
 * Detect cookie format and normalize to Netscape cookies.txt.
 * Supports: Netscape cookies.txt, JSON array (EditThisCookie/cookie-editor),
 * JSON object ({name: value}), and Cookie header string (name=value; ...).
 */
export function normalizeCookieInput(raw: string, fallbackDomain?: string): string {
  const trimmed = raw.trim();

  // Already Netscape cookies.txt? (has tab-separated lines with 7+ fields)
  const lines = trimmed.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (lines.length > 0 && lines[0].split("\t").length >= 7) {
    return trimmed;
  }

  // Try JSON
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      let parsed = JSON.parse(trimmed);

      // JSON object {name: value} -- simple key-value map
      if (!Array.isArray(parsed) && typeof parsed === "object") {
        const entries = Object.entries(parsed as Record<string, unknown>);
        if (entries.length > 0 && entries.every(([, v]) => typeof v === "string" || typeof v === "number")) {
          parsed = entries.map(([name, value]) => ({
            name,
            value: String(value),
            domain: fallbackDomain ?? "unknown.com",
            path: "/",
          }));
        } else if (entries.length > 0) {
          // Might be a single cookie object like {name, value, domain, ...}
          if ("name" in parsed && "value" in parsed) {
            parsed = [parsed];
          }
        }
      }

      if (Array.isArray(parsed) && parsed.length > 0) {
        return jsonCookiesToNetscape(parsed, fallbackDomain);
      }
    } catch {
      // Not valid JSON, fall through
    }
  }

  // Cookie header string: name=value; name2=value2
  if (trimmed.includes("=") && !trimmed.includes("\t")) {
    const pairs = trimmed.split(/;\s*/);
    const cookieLines: string[] = [];
    const domain = fallbackDomain ?? "unknown.com";
    for (const pair of pairs) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx < 1) continue;
      const name = pair.slice(0, eqIdx).trim();
      const value = pair.slice(eqIdx + 1).trim();
      if (!name) continue;
      cookieLines.push(`.${domain}\tTRUE\t/\tFALSE\t0\t${name}\t${value}`);
    }
    if (cookieLines.length > 0) {
      return `# Netscape HTTP Cookie File\n${cookieLines.join("\n")}`;
    }
  }

  // Nothing matched -- return as-is and let parseCookiesTxt reject it
  return trimmed;
}

function jsonCookiesToNetscape(cookies: unknown[], fallbackDomain?: string): string {
  const lines: string[] = ["# Netscape HTTP Cookie File"];
  for (const c of cookies) {
    if (typeof c !== "object" || c === null) continue;
    const cookie = c as Record<string, unknown>;
    const name = String(cookie.name ?? "");
    const value = String(cookie.value ?? "");
    if (!name) continue;

    const domain = String(cookie.domain ?? fallbackDomain ?? "unknown.com");
    const path = String(cookie.path ?? "/");
    const secure = cookie.secure === true || cookie.secure === "true" ? "TRUE" : "FALSE";
    const httpOnly = cookie.httpOnly === true || cookie.httpOnly === "true";
    const expiry = typeof cookie.expirationDate === "number"
      ? Math.round(cookie.expirationDate)
      : typeof cookie.expires === "number"
        ? Math.round(cookie.expires)
        : 0;

    const prefix = httpOnly ? "#HttpOnly_" : "";
    lines.push(`${prefix}${domain}\tTRUE\t${path}\t${secure}\t${expiry}\t${name}\t${value}`);
  }
  return lines.join("\n");
}

export function encryptCookies(cookiesTxt: string): string {
  return encrypt(cookiesTxt);
}

export function decryptCookies(encrypted: string): string {
  return decrypt(encrypted);
}
