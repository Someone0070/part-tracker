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

export function encryptCookies(cookiesTxt: string): string {
  return encrypt(cookiesTxt);
}

export function decryptCookies(encrypted: string): string {
  return decrypt(encrypted);
}
