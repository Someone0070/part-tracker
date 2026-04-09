import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCookiesTxt, matchesDomain, resolveVendorCookies, getAuthCookieExpiry } from "./cookies.js";

const FIXTURE_PATH = resolve(import.meta.dirname, "../../test-fixtures/sample-cookies.txt");

describe("parseCookiesTxt", () => {
  it("parses standard cookies.txt format", () => {
    const content = readFileSync(FIXTURE_PATH, "utf-8");
    const cookies = parseCookiesTxt(content);
    assert.ok(cookies.length >= 5, `Expected >= 5 cookies, got ${cookies.length}`);
  });

  it("handles #HttpOnly_ prefix", () => {
    const content = "#HttpOnly_.example.com\tTRUE\t/\tFALSE\t0\tsid\tabc";
    const cookies = parseCookiesTxt(content);
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].httpOnly, true);
    assert.equal(cookies[0].domain, ".example.com");
    assert.equal(cookies[0].name, "sid");
  });

  it("preserves includeSubdomains field", () => {
    const content = ".example.com\tTRUE\t/\tFALSE\t0\ta\t1\nexample.com\tFALSE\t/\tFALSE\t0\tb\t2";
    const cookies = parseCookiesTxt(content);
    assert.equal(cookies[0].includeSubdomains, true);
    assert.equal(cookies[1].includeSubdomains, false);
  });

  it("skips comment lines and malformed lines", () => {
    const content = "# comment\nshort\tline\n.example.com\tTRUE\t/\tFALSE\t0\tok\tval";
    const cookies = parseCookiesTxt(content);
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].name, "ok");
  });
});

describe("matchesDomain", () => {
  it("matches exact domain", () => {
    assert.equal(matchesDomain("amazon.com", "amazon.com"), true);
  });
  it("matches subdomain", () => {
    assert.equal(matchesDomain("order.ebay.com", "ebay.com"), true);
  });
  it("rejects non-subdomain suffix match", () => {
    assert.equal(matchesDomain("notamazon.com", "amazon.com"), false);
  });
  it("strips www prefix", () => {
    assert.equal(matchesDomain("www.amazon.com", "amazon.com"), true);
  });
  it("is case insensitive", () => {
    assert.equal(matchesDomain("Order.EBAY.com", "ebay.com"), true);
  });
});

describe("resolveVendorCookies", () => {
  const rows = [
    { domain: "ebay.com", vendorName: "eBay" },
    { domain: "identity.ebay.com", vendorName: "eBay Auth" },
  ] as any[];

  it("returns longest-suffix match", () => {
    const result = resolveVendorCookies("signin.identity.ebay.com", rows);
    assert.equal(result?.domain, "identity.ebay.com");
  });
  it("falls back to shorter match", () => {
    const result = resolveVendorCookies("order.ebay.com", rows);
    assert.equal(result?.domain, "ebay.com");
  });
  it("returns null for no match", () => {
    const result = resolveVendorCookies("google.com", rows);
    assert.equal(result, null);
  });
});

describe("getAuthCookieExpiry", () => {
  it("returns earliest auth cookie expiry for amazon", () => {
    const content = readFileSync(FIXTURE_PATH, "utf-8");
    const cookies = parseCookiesTxt(content);
    const expiry = getAuthCookieExpiry(cookies, "amazon.com");
    assert.ok(expiry instanceof Date);
    assert.equal(expiry.getTime(), 1749500000 * 1000);
  });
  it("ignores non-auth cookies", () => {
    const content = ".example.com\tTRUE\t/\tFALSE\t1680000000\tad-tracker\tv\n.example.com\tTRUE\t/\tFALSE\t1749500000\tsession-id\tv";
    const cookies = parseCookiesTxt(content);
    const expiry = getAuthCookieExpiry(cookies, "example.com");
    assert.equal(expiry?.getTime(), 1749500000 * 1000);
  });
  it("returns null when no auth cookies found", () => {
    const content = ".example.com\tTRUE\t/\tFALSE\t1680000000\tga-tracker\tv";
    const cookies = parseCookiesTxt(content);
    const expiry = getAuthCookieExpiry(cookies, "example.com");
    assert.equal(expiry, null);
  });
});
