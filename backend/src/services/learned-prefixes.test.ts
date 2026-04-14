import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractCandidatePrefix, buildPrefixRegex } from "./learned-prefixes.js";

// ---------------------------------------------------------------------------
// extractCandidatePrefix
// ---------------------------------------------------------------------------

describe("extractCandidatePrefix", () => {
  it("extracts single-word uppercase prefix", () => {
    assert.equal(
      extractCandidatePrefix("SHIPPED IGNITOR SVCE", "IGNITOR SVCE"),
      "SHIPPED"
    );
  });

  it("extracts multi-word prefix IN STOCK", () => {
    assert.equal(
      extractCandidatePrefix("IN STOCK IGNITOR SVCE", "IGNITOR SVCE"),
      "IN STOCK"
    );
  });

  it("extracts multi-word prefix OUT OF STOCK", () => {
    assert.equal(
      extractCandidatePrefix("OUT OF STOCK MOTOR ASSY", "MOTOR ASSY"),
      "OUT OF STOCK"
    );
  });

  it("extracts multi-word prefix ON ORDER", () => {
    assert.equal(
      extractCandidatePrefix("ON ORDER PUMP DRAIN", "PUMP DRAIN"),
      "ON ORDER"
    );
  });

  it("returns null when names are identical", () => {
    assert.equal(
      extractCandidatePrefix("IGNITOR SVCE", "IGNITOR SVCE"),
      null
    );
  });

  it("returns null when template is shorter", () => {
    assert.equal(
      extractCandidatePrefix("IGNITOR", "IGNITOR SVCE"),
      null
    );
  });

  it("returns null for mixed-case prefix", () => {
    assert.equal(
      extractCandidatePrefix("Shipped IGNITOR SVCE", "IGNITOR SVCE"),
      null
    );
  });

  it("returns null for prefix containing digits", () => {
    assert.equal(
      extractCandidatePrefix("W10 IGNITOR SVCE", "IGNITOR SVCE"),
      null
    );
  });

  it("returns null for single-char prefix (too short)", () => {
    assert.equal(
      extractCandidatePrefix("X IGNITOR SVCE", "IGNITOR SVCE"),
      null
    );
  });

  it("returns null for very long prefix (>15 chars)", () => {
    assert.equal(
      extractCandidatePrefix("SUPERLONGPREFIXXX IGNITOR SVCE", "IGNITOR SVCE"),
      null
    );
  });

  it("returns null for brand name prefix", () => {
    assert.equal(
      extractCandidatePrefix("WHIRLPOOL IGNITOR SVCE", "IGNITOR SVCE"),
      null
    );
  });

  it("returns null for brand name prefix (case insensitive)", () => {
    assert.equal(
      extractCandidatePrefix("SAMSUNG MOTOR ASSY", "MOTOR ASSY"),
      null
    );
  });

  it("returns null when rest doesn't match nano", () => {
    assert.equal(
      extractCandidatePrefix("SHIPPED TOTALLY DIFFERENT", "IGNITOR SVCE"),
      null
    );
  });

  it("returns null for empty strings", () => {
    assert.equal(extractCandidatePrefix("", "IGNITOR"), null);
    assert.equal(extractCandidatePrefix("SHIPPED IGNITOR", ""), null);
  });

  it("handles whitespace trimming", () => {
    assert.equal(
      extractCandidatePrefix("  SHIPPED IGNITOR SVCE  ", "  IGNITOR SVCE  "),
      "SHIPPED"
    );
  });

  it("extracts BACKORDERED prefix", () => {
    assert.equal(
      extractCandidatePrefix("BACKORDERED PUMP MOTOR", "PUMP MOTOR"),
      "BACKORDERED"
    );
  });

  it("returns null when template is single word", () => {
    assert.equal(
      extractCandidatePrefix("SHIPPED", "SHIP"),
      null
    );
  });
});

// ---------------------------------------------------------------------------
// buildPrefixRegex
// ---------------------------------------------------------------------------

describe("buildPrefixRegex", () => {
  it("matches hardcoded prefixes with no learned", () => {
    const re = buildPrefixRegex([]);
    assert.ok(re.test("SHIPPED IGNITOR SVCE"));
    assert.ok(re.test("BACKORDERED MOTOR ASSY"));
    assert.ok(re.test("B/O PUMP DRAIN"));
    assert.ok(re.test("IN STOCK VALVE"));
    assert.ok(re.test("PENDING IGNITOR"));
  });

  it("matches learned prefixes", () => {
    const re = buildPrefixRegex(["ALLOCATED", "RESERVED"]);
    assert.ok(re.test("ALLOCATED IGNITOR SVCE"));
    assert.ok(re.test("RESERVED MOTOR ASSY"));
  });

  it("does not match in the middle of a string", () => {
    const re = buildPrefixRegex([]);
    assert.ok(!re.test("IGNITOR SHIPPED SVCE"));
  });

  it("is case insensitive", () => {
    const re = buildPrefixRegex(["ALLOCATED"]);
    assert.ok(re.test("allocated IGNITOR SVCE"));
    assert.ok(re.test("Shipped MOTOR"));
  });

  it("deduplicates learned prefixes that match hardcoded", () => {
    const re = buildPrefixRegex(["SHIPPED", "ALLOCATED"]);
    // Should still work -- no duplicate patterns
    assert.ok(re.test("SHIPPED IGNITOR"));
    assert.ok(re.test("ALLOCATED MOTOR"));
  });

  it("escapes special regex chars in learned prefixes", () => {
    const re = buildPrefixRegex(["B/O"]);
    // B/O is already hardcoded, but test that escaping works
    assert.ok(re.test("B/O MOTOR ASSY"));
  });

  it("requires whitespace after prefix", () => {
    const re = buildPrefixRegex([]);
    assert.ok(!re.test("SHIPPEDMOTOR"));
  });
});
