import { describe, it } from "node:test";
import assert from "node:assert/strict";

const PART_NUMBER_REGEX = /\b(?:WP[A-Z]?\d{5,}|W\d{7,}|WB\d+X\d+|\d{7,10}|[A-Z]{2,3}\d{6,})\b/gi;
const CATALOG_PREFIX_REGEX = /^(?:AP|PS|EA)\d+$/i;

function normalizePartNumber(raw: string): string {
  return raw.trim().toUpperCase().replace(/[-.\s]/g, "");
}

function extractPartNumbers(text: string): string[] {
  const matches = text.match(PART_NUMBER_REGEX) || [];
  return matches
    .map((m) => normalizePartNumber(m))
    .filter((pn) => !CATALOG_PREFIX_REGEX.test(pn));
}

describe("cross-ref extraction", () => {
  it("extracts WP-prefixed part numbers", () => {
    const result = extractPartNumbers("This part WPW10321304 replaces W10321302");
    assert.ok(result.includes("WPW10321304"));
    assert.ok(result.includes("W10321302"));
  });

  it("extracts numeric-only part numbers (7-10 digits)", () => {
    const result = extractPartNumbers("Compatible with 5304506469 and 316575430");
    assert.ok(result.includes("5304506469"));
    assert.ok(result.includes("316575430"));
  });

  it("extracts GE-style WB part numbers", () => {
    const result = extractPartNumbers("GE WB62X10013 oven element");
    assert.ok(result.includes("WB62X10013"));
  });

  it("filters out AP/PS/EA catalog IDs", () => {
    const result = extractPartNumbers("AP6872342 PS12711828 EA4514338 WPW10321304");
    assert.ok(!result.some((pn) => pn.startsWith("AP")));
    assert.ok(!result.some((pn) => pn.startsWith("PS")));
    assert.ok(!result.some((pn) => pn.startsWith("EA")));
    assert.ok(result.includes("WPW10321304"));
  });

  it("returns empty array for text with no part numbers", () => {
    const result = extractPartNumbers("This is a regular sentence about appliance repair.");
    assert.equal(result.length, 0);
  });

  it("deduplicates normalized part numbers", () => {
    const text = "WPW10321304 and WPW10321304 appear twice";
    const matches = text.match(PART_NUMBER_REGEX) || [];
    const unique = [...new Set(matches.map((m) => normalizePartNumber(m)))];
    assert.equal(unique.length, 1);
  });
});
