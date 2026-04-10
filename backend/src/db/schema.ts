import { pgTable, serial, text, integer, boolean, timestamp, unique, check, index } from "drizzle-orm/pg-core";
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
  applianceId: integer("appliance_id").references(() => appliances.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  check("listed_quantity_check", sql`${table.listedQuantity} >= 0 AND ${table.listedQuantity} <= ${table.quantity}`),
  index("parts_updated_at_idx").on(table.updatedAt),
  index("parts_appliance_id_idx").on(table.applianceId),
]);

export const appliances = pgTable("appliances", {
  id: serial("id").primaryKey(),
  brand: text("brand"),
  modelNumber: text("model_number"),
  serialNumber: text("serial_number"),
  applianceType: text("appliance_type"),
  notes: text("notes"),
  photoKey: text("photo_key"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("appliances_created_at_idx").on(table.createdAt),
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
  index("cross_references_part_id_idx").on(table.partId),
  index("cross_references_cross_ref_pn_idx").on(table.crossRefPartNumber),
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
  apiKeyHash: text("api_key_hash"),
  apiKeyPrefix: text("api_key_prefix"),
  apiKeyScopes: text("api_key_scopes"),
  templateModel: text("template_model").notNull().default("qwen/qwen3.5-flash-02-23"),
});

export const inventoryEvents = pgTable("inventory_events", {
  id: serial("id").primaryKey(),
  partId: integer("part_id").notNull().references(() => parts.id),
  eventType: text("event_type").notNull(),
  quantityChange: integer("quantity_change").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("inventory_events_part_created_idx").on(table.partId, table.createdAt),
]);

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

export const vendorTemplates = pgTable("vendor_templates", {
  id: serial("id").primaryKey(),
  vendorKey: text("vendor_key").notNull().unique(),
  vendorName: text("vendor_name").notNull(),
  vendorDomains: text("vendor_domains").array().notNull().default(sql`'{}'::text[]`),
  vendorKeywords: text("vendor_keywords").array().notNull().default(sql`'{}'::text[]`),
  extractionRules: text("extraction_rules").notNull(),
  successCount: integer("success_count").notNull().default(0),
  failCount: integer("fail_count").notNull().default(0),
  lastGenerationAttempt: timestamp("last_generation_attempt", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const vendorCookies = pgTable("vendor_cookies", {
  id: serial("id").primaryKey(),
  vendorName: text("vendor_name").notNull(),
  domain: text("domain").notNull().unique(),
  cookieData: text("cookie_data").notNull(),
  authCookieExpiry: timestamp("auth_cookie_expiry"),
  isPreset: boolean("is_preset").notNull().default(false),
  status: text("status").notNull().default("unconfigured"),
  lastTestedAt: timestamp("last_tested_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const vendorPresets = pgTable("vendor_presets", {
  id: serial("id").primaryKey(),
  vendorKey: text("vendor_key").notNull(),
  inputType: text("input_type").notNull(),
  pageFingerprint: text("page_fingerprint").notNull(),
  selectors: text("selectors").notNull(),
  sampleSnippet: text("sample_snippet"),
  successCount: integer("success_count").notNull().default(0),
  failCount: integer("fail_count").notNull().default(0),
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  unique("vendor_preset_unique").on(table.vendorKey, table.inputType, table.pageFingerprint),
]);
