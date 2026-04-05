import { pgTable, serial, text, integer, boolean, timestamp, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const parts = pgTable("parts", {
  id: serial("id").primaryKey(),
  partNumber: text("part_number").notNull().unique(),
  partNumberRaw: text("part_number_raw").notNull(),
  brand: text("brand"),
  description: text("description"),
  quantity: integer("quantity").notNull().default(0),
  listedQuantity: integer("listed_quantity").notNull().default(0),
  ebayListingId: text("ebay_listing_id").unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  check("listed_quantity_check", sql`${table.listedQuantity} >= 0 AND ${table.listedQuantity} <= ${table.quantity}`),
]);

export const crossReferences = pgTable("cross_references", {
  id: serial("id").primaryKey(),
  partId: integer("part_id").notNull().references(() => parts.id),
  crossRefPartNumber: text("cross_ref_part_number").notNull(),
  relationship: text("relationship").notNull(),
  sourceUrl: text("source_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  unique("cross_ref_unique").on(table.partId, table.crossRefPartNumber),
]);

export const settings = pgTable("settings", {
  id: serial("id").primaryKey(),
  crossRefEnabled: boolean("cross_ref_enabled").notNull().default(false),
  ebayEnabled: boolean("ebay_enabled").notNull().default(false),
  ebayAccessToken: text("ebay_access_token"),
  ebayRefreshToken: text("ebay_refresh_token"),
  ebayTokenExpiresAt: timestamp("ebay_token_expires_at"),
  darkMode: boolean("dark_mode").notNull().default(false),
  passwordHash: text("password_hash").notNull(),
  passwordVersion: integer("password_version").notNull().default(1),
  pendingEbayState: text("pending_ebay_state"),
  pendingEbayStateExpires: timestamp("pending_ebay_state_expires"),
});

export const inventoryEvents = pgTable("inventory_events", {
  id: serial("id").primaryKey(),
  partId: integer("part_id").notNull().references(() => parts.id),
  eventType: text("event_type").notNull(),
  quantityChange: integer("quantity_change").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const ebayProcessedOrders = pgTable("ebay_processed_orders", {
  id: serial("id").primaryKey(),
  ebayOrderId: text("ebay_order_id").notNull(),
  ebayLineItemId: text("ebay_line_item_id").notNull(),
  partId: integer("part_id").references(() => parts.id),
  quantityDepleted: integer("quantity_depleted").notNull(),
  quarantineReason: text("quarantine_reason"),
  processedAt: timestamp("processed_at").notNull().defaultNow(),
}, (table) => [
  unique("ebay_order_line_unique").on(table.ebayOrderId, table.ebayLineItemId),
]);

export const ebayPollWatermark = pgTable("ebay_poll_watermark", {
  id: serial("id").primaryKey(),
  lastPolledAt: timestamp("last_polled_at").notNull(),
});

export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  refreshTokenHash: text("refresh_token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
