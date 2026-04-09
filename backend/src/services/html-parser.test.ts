import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { redactForLlm, scrubHtmlForSelectors, parseHtmlWithSelectors } from "./html-parser.js";
import type { HtmlSelectorConfig } from "./vendor-presets.js";

const AMAZON_HTML = readFileSync(resolve(import.meta.dirname, "../../test-fixtures/amazon-order.html"), "utf-8");
const EBAY_HTML = readFileSync(resolve(import.meta.dirname, "../../test-fixtures/ebay-order.html"), "utf-8");

describe("redactForLlm", () => {
  it("removes scripts and styles", () => {
    const html = "<html><body><script>secret</script><p>content</p><style>.x{}</style></body></html>";
    const text = redactForLlm(html);
    assert.ok(!text.includes("secret"));
    assert.ok(!text.includes(".x{}"));
    assert.ok(text.includes("content"));
  });

  it("removes shipping/address containers", () => {
    const html = '<html><body><div class="shipping-address">John Smith 123 Main St</div><p>Item $10</p></body></html>';
    const text = redactForLlm(html);
    assert.ok(!text.includes("John Smith"));
    assert.ok(!text.includes("123 Main St"));
    assert.ok(text.includes("Item $10"));
  });

  it("scrubs email addresses from text", () => {
    const html = "<html><body><p>Contact john@example.com for info</p></body></html>";
    const text = redactForLlm(html);
    assert.ok(!text.includes("john@example.com"));
    assert.ok(text.includes("[EMAIL]"));
  });

  it("truncates to 6000 chars", () => {
    const html = `<html><body><p>${"x".repeat(10000)}</p></body></html>`;
    const text = redactForLlm(html);
    assert.ok(text.length <= 6000);
  });
});

describe("scrubHtmlForSelectors", () => {
  it("removes hidden inputs", () => {
    const html = '<html><body><input type="hidden" name="csrf" value="secret123"><div class="item">Product</div></body></html>';
    const result = scrubHtmlForSelectors(html);
    assert.ok(!result.includes("secret123"));
    assert.ok(result.includes("item"));
  });

  it("strips non-structural attributes", () => {
    const html = '<html><body><a href="https://secret.url/token=abc" class="link" data-track="123">Click</a></body></html>';
    const result = scrubHtmlForSelectors(html);
    assert.ok(!result.includes("secret.url"));
    assert.ok(!result.includes("data-track"));
    assert.ok(result.includes('class="link"'));
  });

  it("redacts text in address/billing containers", () => {
    const html = '<html><body><div class="billing-info">Visa ending in 5637</div><div class="item">Product A</div></body></html>';
    const result = scrubHtmlForSelectors(html);
    assert.ok(!result.includes("Visa ending in 5637"));
    assert.ok(result.includes("[REDACTED]"));
    assert.ok(result.includes("Product A"));
  });

  it("truncates to 8000 chars", () => {
    const html = `<html><body>${"<div class='x'>y</div>".repeat(2000)}</body></html>`;
    const result = scrubHtmlForSelectors(html);
    assert.ok(result.length <= 8000);
  });
});

describe("parseHtmlWithSelectors", () => {
  it("extracts items using selector config", () => {
    const config: HtmlSelectorConfig = {
      type: "html",
      itemContainer: ".a-fixed-left-grid.shipment",
      fields: {
        partName: ".yohtmlc-product-title",
        unitPrice: ".a-color-price",
        quantity: ".item-view-qty",
      },
    };
    const result = parseHtmlWithSelectors(AMAZON_HTML, config, "amazon");
    assert.equal(result.items.length, 2);
    assert.ok(result.items[0].partName.includes("Calcium Citrate"));
    assert.equal(result.items[0].unitPrice, 26.97);
    assert.equal(result.items[0].quantity, 1);
  });

  it("built-in Amazon config extracts exactly 2 items (no double-counting)", () => {
    const config: HtmlSelectorConfig = {
      type: "html",
      itemContainer: ".a-fixed-left-grid.shipment",
      fields: {
        partName: ".yohtmlc-product-title",
        unitPrice: ".a-color-price",
        quantity: ".item-view-qty",
      },
      orderFields: {
        orderNumber: ".order-date-invoice-item .a-color-secondary",
        orderDate: ".order-date-invoice-item span:not(.a-color-secondary)",
        totalShipping: ".shipping-total",
        totalTax: ".tax-total",
      },
    };
    const result = parseHtmlWithSelectors(AMAZON_HTML, config, "amazon");
    assert.equal(result.items.length, 2, `Expected 2 items, got ${result.items.length}`);
    assert.ok(result.orderNumber?.includes("114-9176254"), `orderNumber should contain order ID, got: ${result.orderNumber}`);
    assert.ok(result.orderDate?.includes("April"), `orderDate should contain month, got: ${result.orderDate}`);
    assert.notEqual(result.orderNumber, result.orderDate, "orderNumber and orderDate must differ");
  });

  it("extracts order-level fields", () => {
    const config: HtmlSelectorConfig = {
      type: "html",
      itemContainer: ".line-item",
      fields: {
        partName: ".item-title",
        unitPrice: ".item-price",
        quantity: ".item-qty",
      },
      orderFields: {
        orderNumber: ".order-number",
        orderDate: ".order-date",
      },
    };
    const result = parseHtmlWithSelectors(EBAY_HTML, config, "ebay");
    assert.equal(result.orderNumber, "21-14238-30663");
    assert.equal(result.orderDate, "Apr 2, 2026");
    assert.equal(result.items.length, 2);
  });
});
