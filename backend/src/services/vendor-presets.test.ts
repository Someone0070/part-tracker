import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateExtractionResult, computePageFingerprint, computePdfFingerprint } from "./vendor-presets.js";
import type { DocumentResult } from "./document-parser.js";

function makeResult(overrides: Partial<DocumentResult> = {}): DocumentResult {
  return {
    vendor: "test",
    orderNumber: "123",
    orderDate: "2026-01-01",
    technicianName: null,
    trackingNumber: null,
    deliveryCourier: null,
    items: [
      { partNumber: "WP12345", partName: "Test Pump", quantity: 1, unitPrice: 29.99, shipCost: null, taxPrice: null, brand: null },
    ],
    rawText: "test",
    ...overrides,
  };
}

describe("validateExtractionResult", () => {
  it("accepts valid result", () => {
    const result = validateExtractionResult(makeResult());
    assert.equal(result.valid, true);
    assert.equal(result.issues.length, 0);
  });

  it("rejects zero items", () => {
    const result = validateExtractionResult(makeResult({ items: [] }));
    assert.equal(result.valid, false);
    assert.ok(result.issues[0].includes("No items"));
  });

  it("rejects when less than 50% have names", () => {
    const result = validateExtractionResult(makeResult({
      items: [
        { partNumber: "", partName: "", quantity: 1, unitPrice: 10, shipCost: null, taxPrice: null, brand: null },
        { partNumber: "", partName: "x", quantity: 1, unitPrice: 10, shipCost: null, taxPrice: null, brand: null },
        { partNumber: "WP123", partName: "Good Item", quantity: 1, unitPrice: 10, shipCost: null, taxPrice: null, brand: null },
      ],
    }));
    assert.equal(result.valid, false);
  });

  it("rejects invalid quantities", () => {
    const result = validateExtractionResult(makeResult({
      items: [
        { partNumber: "WP123", partName: "Test", quantity: 0, unitPrice: 10, shipCost: null, taxPrice: null, brand: null },
      ],
    }));
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.includes("quantities")));
  });

  it("rejects unreasonable prices", () => {
    const result = validateExtractionResult(makeResult({
      items: [
        { partNumber: "WP123", partName: "Test", quantity: 1, unitPrice: 100000, shipCost: null, taxPrice: null, brand: null },
      ],
    }));
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.includes("prices")));
  });

  it("rejects all identical names", () => {
    const result = validateExtractionResult(makeResult({
      items: [
        { partNumber: "", partName: "Same Name", quantity: 1, unitPrice: 10, shipCost: null, taxPrice: null, brand: null },
        { partNumber: "", partName: "Same Name", quantity: 1, unitPrice: 20, shipCost: null, taxPrice: null, brand: null },
        { partNumber: "", partName: "Same Name", quantity: 1, unitPrice: 30, shipCost: null, taxPrice: null, brand: null },
      ],
    }));
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.includes("identical")));
  });
});

describe("computePageFingerprint", () => {
  it("produces stable 12-char hex fingerprint", () => {
    const html = "<html><body><main><div id='order-details'><div></div></div></main></body></html>";
    const fp = computePageFingerprint(html);
    assert.equal(fp.length, 12);
    assert.match(fp, /^[a-f0-9]{12}$/);
  });

  it("is stable across text content changes", () => {
    const html1 = "<html><body><main><div id='content'><p>Order 123</p></div></main></body></html>";
    const html2 = "<html><body><main><div id='content'><p>Order 456</p></div></main></body></html>";
    assert.equal(computePageFingerprint(html1), computePageFingerprint(html2));
  });

  it("ignores volatile containers", () => {
    const base = "<html><body><main><div id='order'></div></main></body></html>";
    const withAds = "<html><body><main><div id='order'></div></main><aside>Ads</aside></body></html>";
    assert.equal(computePageFingerprint(base), computePageFingerprint(withAds));
  });

  it("excludes dynamic IDs", () => {
    const html1 = "<html><body><main><div id='container-12345678'></div></main></body></html>";
    const html2 = "<html><body><main><div id='container-87654321'></div></main></body></html>";
    assert.equal(computePageFingerprint(html1), computePageFingerprint(html2));
  });
});

describe("computePdfFingerprint", () => {
  it("produces stable fingerprint from section headers", () => {
    const text1 = "Items Ordered Price\nSomething\nOrder #123\nShipping & Handling: $5.00";
    const text2 = "Items Ordered Price\nDifferent\nOrder #456\nShipping & Handling: $10.00";
    assert.equal(computePdfFingerprint(text1), computePdfFingerprint(text2));
  });
});
