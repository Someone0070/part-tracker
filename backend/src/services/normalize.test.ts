import { describe, it } from "node:test";
import * as assert from "node:assert";
import { normalizePartNumber } from "./normalize.js";

describe("normalizePartNumber", () => {
  it("uppercases input", () => {
    assert.strictEqual(normalizePartNumber("wpw10321304"), "WPW10321304");
  });

  it("strips dashes", () => {
    assert.strictEqual(normalizePartNumber("WP-W10321304"), "WPW10321304");
  });

  it("strips dots", () => {
    assert.strictEqual(normalizePartNumber("W.10321304"), "W10321304");
  });

  it("strips spaces", () => {
    assert.strictEqual(normalizePartNumber("W 103 213 04"), "W10321304");
  });

  it("trims whitespace", () => {
    assert.strictEqual(normalizePartNumber("  WPW10321304  "), "WPW10321304");
  });

  it("handles combined cases", () => {
    assert.strictEqual(normalizePartNumber("  wp-w.103 213-04  "), "WPW10321304");
  });
});
