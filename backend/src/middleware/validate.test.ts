import { describe, it } from "node:test";
import * as assert from "node:assert";
import { addPartSchema, depletePartSchema, updateSettingsSchema, changePasswordSchema, updatePartSchema } from "./validate.js";

describe("addPartSchema", () => {
  it("accepts valid input", () => {
    const result = addPartSchema.safeParse({
      partNumber: "WPW10321304",
      quantity: 3,
      note: "From Kenmore",
    });
    assert.ok(result.success);
  });

  it("requires partNumber", () => {
    const result = addPartSchema.safeParse({ quantity: 1 });
    assert.ok(!result.success);
  });

  it("rejects partNumber over 50 chars", () => {
    const result = addPartSchema.safeParse({ partNumber: "A".repeat(51) });
    assert.ok(!result.success);
  });

  it("rejects quantity of 0", () => {
    const result = addPartSchema.safeParse({ partNumber: "X", quantity: 0 });
    assert.ok(!result.success);
  });

  it("defaults quantity to 1", () => {
    const result = addPartSchema.safeParse({ partNumber: "X" });
    assert.ok(result.success);
    assert.strictEqual(result.data.quantity, 1);
  });

  it("rejects note over 1000 chars", () => {
    const result = addPartSchema.safeParse({ partNumber: "X", note: "A".repeat(1001) });
    assert.ok(!result.success);
  });
});

describe("depletePartSchema", () => {
  it("accepts valid input", () => {
    const result = depletePartSchema.safeParse({ quantity: 1, reason: "used" });
    assert.ok(result.success);
  });

  it("rejects invalid reason", () => {
    const result = depletePartSchema.safeParse({ quantity: 1, reason: "lost" });
    assert.ok(!result.success);
  });

  it("rejects quantity of 0", () => {
    const result = depletePartSchema.safeParse({ quantity: 0, reason: "used" });
    assert.ok(!result.success);
  });
});

describe("changePasswordSchema", () => {
  it("rejects password over 72 chars", () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: "old",
      newPassword: "A".repeat(73),
    });
    assert.ok(!result.success);
  });
});
