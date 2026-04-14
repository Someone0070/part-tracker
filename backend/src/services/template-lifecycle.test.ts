import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendResult,
  shouldEvict,
  findWeakestVersion,
  needsSpotCheck,
  type RecentResult,
} from "./template-lifecycle.js";

// Helpers
function pass(): RecentResult { return { pass: true, ts: new Date().toISOString() }; }
function fail(): RecentResult { return { pass: false, ts: new Date().toISOString() }; }
function unverified(): RecentResult { return { pass: null, ts: new Date().toISOString() }; }

describe("appendResult", () => {
  it("appends to empty array", () => {
    const result = appendResult([], true);
    assert.equal(result.length, 1);
    assert.equal(result[0].pass, true);
    assert.ok(result[0].ts);
  });

  it("appends to existing results", () => {
    const existing: RecentResult[] = [pass(), fail()];
    const result = appendResult(existing, null);
    assert.equal(result.length, 3);
    assert.equal(result[2].pass, null);
  });

  it("caps at 10, dropping oldest", () => {
    const existing: RecentResult[] = Array.from({ length: 10 }, () => pass());
    const result = appendResult(existing, false);
    assert.equal(result.length, 10);
    assert.equal(result[9].pass, false);
  });

  it("exactly 10 existing: drops first, appends new", () => {
    const existing: RecentResult[] = Array.from({ length: 10 }, (_, i) =>
      ({ pass: i % 2 === 0, ts: new Date(i * 1000).toISOString() })
    );
    const result = appendResult(existing, true);
    assert.equal(result.length, 10);
    assert.equal(result[0], existing[1]); // oldest dropped
    assert.equal(result[9].pass, true);
  });
});

describe("shouldEvict", () => {
  it("returns false with fewer than 5 scored results", () => {
    const results: RecentResult[] = [fail(), fail(), fail(), fail(), unverified()];
    assert.equal(shouldEvict(results), false);
  });

  it("returns true with 5+ scored results and 0 passes", () => {
    const results: RecentResult[] = [fail(), fail(), fail(), fail(), fail()];
    assert.equal(shouldEvict(results), true);
  });

  it("returns false with 5+ scored results and at least one pass", () => {
    const results: RecentResult[] = [fail(), fail(), fail(), fail(), pass()];
    assert.equal(shouldEvict(results), false);
  });

  it("ignores null (unverified) results in scoring", () => {
    // 4 fails + 4 nulls = only 4 scored, should not evict
    const results: RecentResult[] = [
      fail(), fail(), fail(), fail(),
      unverified(), unverified(), unverified(), unverified(),
    ];
    assert.equal(shouldEvict(results), false);
  });

  it("evicts when 5 scored all fail with mixed nulls", () => {
    const results: RecentResult[] = [
      fail(), fail(), fail(), fail(), fail(),
      unverified(), unverified(),
    ];
    assert.equal(shouldEvict(results), true);
  });
});

describe("findWeakestVersion", () => {
  it("returns lowest pass rate among versions all above min sample", () => {
    const versions = [
      { id: 1, recentResults: [pass(), pass(), pass(), pass(), pass()] }, // 100%
      { id: 2, recentResults: [fail(), fail(), pass(), pass(), pass()] }, // 60%
      { id: 3, recentResults: [fail(), fail(), fail(), pass(), pass()] }, // 40%
    ];
    assert.equal(findWeakestVersion(versions), 3);
  });

  it("prefers evicting below-min-sample over low-rate above-min-sample", () => {
    const versions = [
      { id: 1, recentResults: [fail(), fail(), fail(), fail(), fail()] }, // 0% but above min
      { id: 2, recentResults: [pass(), pass()] }, // below min sample
    ];
    // id 2 is below min sample, id 1 is above min — id 2 should be weakest
    assert.equal(findWeakestVersion(versions), 2);
  });

  it("returns first below-min-sample when all are below min", () => {
    const versions = [
      { id: 1, recentResults: [pass(), pass()] },
      { id: 2, recentResults: [pass()] },
    ];
    assert.equal(findWeakestVersion(versions), 1);
  });

  it("handles single version", () => {
    const versions = [
      { id: 42, recentResults: [pass(), pass(), pass(), pass(), pass()] },
    ];
    assert.equal(findWeakestVersion(versions), 42);
  });

  it("tie-breaks to first encountered", () => {
    const versions = [
      { id: 1, recentResults: [fail(), fail(), fail(), pass(), pass()] }, // 40%
      { id: 2, recentResults: [fail(), fail(), fail(), pass(), pass()] }, // 40%
    ];
    assert.equal(findWeakestVersion(versions), 1);
  });
});

describe("needsSpotCheck", () => {
  it("returns false with fewer than 5 consecutive unverified at end", () => {
    const results: RecentResult[] = [
      unverified(), unverified(), unverified(), unverified(),
    ];
    assert.equal(needsSpotCheck(results), false);
  });

  it("returns true with 5+ consecutive unverified at end", () => {
    const results: RecentResult[] = [
      unverified(), unverified(), unverified(), unverified(), unverified(),
    ];
    assert.equal(needsSpotCheck(results), true);
  });

  it("returns false if any result has pass === true", () => {
    const results: RecentResult[] = [
      pass(),
      unverified(), unverified(), unverified(), unverified(), unverified(),
    ];
    assert.equal(needsSpotCheck(results), false);
  });

  it("resets count on non-null result in sequence", () => {
    // 4 unverified at end, but a fail before them breaks streak
    const results: RecentResult[] = [
      unverified(), unverified(), unverified(), unverified(),
      fail(),
      unverified(), unverified(), unverified(), unverified(),
    ];
    // streak at end is 4, not 5
    assert.equal(needsSpotCheck(results), false);
  });

  it("returns true when 5+ unverified even with fail before them", () => {
    const results: RecentResult[] = [
      fail(),
      unverified(), unverified(), unverified(), unverified(), unverified(),
    ];
    assert.equal(needsSpotCheck(results), true);
  });

  it("returns false on empty array", () => {
    assert.equal(needsSpotCheck([]), false);
  });
});
