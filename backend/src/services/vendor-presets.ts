import crypto from "node:crypto";
import * as cheerio from "cheerio";
import { getDb } from "../db/index.js";
import { vendorPresets } from "../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import type { DocumentResult, ExtractedItem } from "./document-parser.js";

export type { DocumentResult };

// --- Interfaces ---

export interface HtmlSelectorConfig {
  type: "html";
  itemContainer: string;
  fields: {
    partName: string;
    quantity: string;
    unitPrice: string;
    partNumber?: string;
    seller?: string;
    imageUrl?: string;
  };
  orderFields?: {
    orderNumber?: string;
    orderDate?: string;
    technicianName?: string;
    trackingNumber?: string;
    deliveryCourier?: string;
    totalShipping?: string;
    totalTax?: string;
  };
}

export interface PdfRegexConfig {
  type: "pdf";
  vendorDetectPattern: string;
  itemLinePattern?: string;
  itemBlockSplitter?: string;
  fields: {
    partNumber?: string;
    partName?: string;
    quantity?: string;
    unitPrice?: string;
  };
  orderFields?: {
    orderNumber?: string;
    orderDate?: string;
    technicianName?: string;
    trackingNumber?: string;
    totalShipping?: string;
    totalTax?: string;
  };
}

export type VendorSelectorConfig = HtmlSelectorConfig | PdfRegexConfig;

export interface ValidationResult {
  valid: boolean;
  itemCount: number;
  issues: string[];
}

// --- Validation ---

export function validateExtractionResult(result: DocumentResult): ValidationResult {
  const issues: string[] = [];

  if (result.items.length === 0) {
    issues.push("No items extracted");
    return { valid: false, itemCount: 0, issues };
  }

  const identifiedCount = result.items.filter(
    (i) => i.partName.length > 2 || i.partNumber.length > 2
  ).length;
  if (identifiedCount / result.items.length < 0.5) {
    issues.push("Less than 50% of items have identifiable names or part numbers");
  }

  const badQty = result.items.filter((i) => i.quantity < 1 || !Number.isInteger(i.quantity));
  if (badQty.length > 0) {
    issues.push(`${badQty.length} items have invalid quantities`);
  }

  const badPrice = result.items.filter(
    (i) => i.unitPrice !== null && (i.unitPrice < 0.01 || i.unitPrice > 50000)
  );
  if (badPrice.length > 0) {
    issues.push(`${badPrice.length} items have unreasonable prices`);
  }

  const names = result.items.map((i) => i.partName).filter((n) => n.length > 0);
  const uniqueNames = new Set(names);
  if (names.length > 2 && uniqueNames.size === 1) {
    issues.push("All items have identical names -- selector may be wrong");
  }

  return { valid: issues.length === 0, itemCount: result.items.length, issues };
}

// --- Page Fingerprinting ---

export function computePageFingerprint(html: string): string {
  const $ = cheerio.load(html);

  // Remove volatile containers
  $("[class*='recommend'], [class*='suggestion'], [class*='also-bought']").remove();
  $("[class*='cookie-banner'], [class*='consent'], [class*='gdpr']").remove();
  $("[class*='experiment'], [class*='ab-test'], [class*='variant']").remove();
  $("[id*='sponsored'], [id*='ad-'], [class*='ad-slot']").remove();
  $("aside, [role='complementary'], [role='banner']").remove();

  const main = $("main, [role='main'], #content, .content, article").first();
  const root = main.length ? main : $("body");

  const structural = root
    .children()
    .map((_: number, el: any) => {
      const tag = el.tagName;
      const id = $(el).attr("id") || "";
      const stableId = id && !/\d{4,}|[0-9a-f]{8}-|^[a-f0-9]{8,}$/i.test(id) ? id : "";
      return `${tag}${stableId ? "#" + stableId : ""}`;
    })
    .get()
    .join("|");

  return crypto.createHash("sha256").update(structural).digest("hex").slice(0, 12);
}

const PDF_SECTION_MARKERS = [
  /items ordered/i,
  /order\s*#/i,
  /shipping\s*&\s*handling/i,
  /invoice/i,
  /order number/i,
  /subtotal/i,
  /grand total/i,
  /tracking/i,
  /ship to/i,
  /sold by/i,
];

export function computePdfFingerprint(text: string): string {
  const found = PDF_SECTION_MARKERS
    .filter((m) => m.test(text))
    .map((m) => m.source)
    .sort();
  return crypto.createHash("sha256").update(found.join("|")).digest("hex").slice(0, 12);
}

// --- Preset CRUD ---

const FAIL_THRESHOLD = parseInt(process.env.PRESET_FAIL_THRESHOLD || "3", 10);

export async function tryPresetParse(
  vendorKey: string,
  inputType: "html" | "pdf",
  fingerprint: string
): Promise<{ preset: typeof vendorPresets.$inferSelect; config: VendorSelectorConfig } | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(vendorPresets)
    .where(
      and(
        eq(vendorPresets.vendorKey, vendorKey),
        eq(vendorPresets.inputType, inputType),
        eq(vendorPresets.pageFingerprint, fingerprint)
      )
    )
    .limit(1);

  if (!row) return null;
  if (row.failCount >= FAIL_THRESHOLD) return null;

  const config = JSON.parse(row.selectors) as VendorSelectorConfig;
  return { preset: row, config };
}

export async function savePreset(
  vendorKey: string,
  inputType: "html" | "pdf",
  fingerprint: string,
  config: VendorSelectorConfig,
  sampleSnippet: string | null
): Promise<void> {
  const db = getDb();
  const existing = await db
    .select({ id: vendorPresets.id })
    .from(vendorPresets)
    .where(
      and(
        eq(vendorPresets.vendorKey, vendorKey),
        eq(vendorPresets.inputType, inputType),
        eq(vendorPresets.pageFingerprint, fingerprint)
      )
    )
    .limit(1);

  const now = new Date();
  if (existing.length > 0) {
    await db
      .update(vendorPresets)
      .set({
        selectors: JSON.stringify(config),
        sampleSnippet: sampleSnippet?.slice(0, 2000) ?? null,
        successCount: 1,
        failCount: 0,
        lastUsedAt: now,
        updatedAt: now,
      })
      .where(eq(vendorPresets.id, existing[0].id));
  } else {
    await db.insert(vendorPresets).values({
      vendorKey,
      inputType,
      pageFingerprint: fingerprint,
      selectors: JSON.stringify(config),
      sampleSnippet: sampleSnippet?.slice(0, 2000) ?? null,
      successCount: 1,
      failCount: 0,
      lastUsedAt: now,
    });
  }
}

export async function recordPresetSuccess(presetId: number): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db.execute(
    sql`UPDATE vendor_presets SET success_count = success_count + 1, fail_count = 0, last_used_at = ${now}, updated_at = ${now} WHERE id = ${presetId}`
  );
}

export async function recordPresetFailure(presetId: number): Promise<boolean> {
  const db = getDb();
  await db.execute(
    sql`UPDATE vendor_presets SET fail_count = fail_count + 1, updated_at = NOW() WHERE id = ${presetId}`
  );
  const [row] = await db
    .select({ failCount: vendorPresets.failCount })
    .from(vendorPresets)
    .where(eq(vendorPresets.id, presetId))
    .limit(1);
  return (row?.failCount ?? 0) >= FAIL_THRESHOLD;
}
