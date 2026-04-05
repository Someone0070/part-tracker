import { describe, it } from "node:test";
import * as assert from "node:assert";
import { parts, crossReferences, settings, inventoryEvents, ebayProcessedOrders, ebayPollWatermark, sessions } from "./schema.js";

describe("schema", () => {
  it("parts table has all required columns", () => {
    const cols = Object.keys(parts);
    assert.ok(cols.includes("id"));
    assert.ok(cols.includes("partNumber"));
    assert.ok(cols.includes("partNumberRaw"));
    assert.ok(cols.includes("brand"));
    assert.ok(cols.includes("description"));
    assert.ok(cols.includes("quantity"));
    assert.ok(cols.includes("listedQuantity"));
    assert.ok(cols.includes("ebayListingId"));
    assert.ok(cols.includes("createdAt"));
    assert.ok(cols.includes("updatedAt"));
  });

  it("settings table has all required columns", () => {
    const cols = Object.keys(settings);
    assert.ok(cols.includes("crossRefEnabled"));
    assert.ok(cols.includes("ebayEnabled"));
    assert.ok(cols.includes("ebayAccessToken"));
    assert.ok(cols.includes("ebayRefreshToken"));
    assert.ok(cols.includes("ebayTokenExpiresAt"));
    assert.ok(cols.includes("darkMode"));
    assert.ok(cols.includes("passwordHash"));
    assert.ok(cols.includes("passwordVersion"));
    assert.ok(cols.includes("pendingEbayState"));
    assert.ok(cols.includes("pendingEbayStateExpires"));
  });

  it("inventory_events table has all required columns", () => {
    const cols = Object.keys(inventoryEvents);
    assert.ok(cols.includes("partId"));
    assert.ok(cols.includes("eventType"));
    assert.ok(cols.includes("quantityChange"));
    assert.ok(cols.includes("note"));
  });

  it("sessions table stores hashed tokens", () => {
    const cols = Object.keys(sessions);
    assert.ok(cols.includes("refreshTokenHash"));
    assert.ok(!cols.includes("refreshToken"), "should not store raw refresh token");
  });

  it("ebay_processed_orders has quarantine support", () => {
    const cols = Object.keys(ebayProcessedOrders);
    assert.ok(cols.includes("quarantineReason"));
  });
});
