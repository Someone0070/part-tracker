import { getDb } from "../db/index.js";
import { vendorTemplates } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import type { VendorTemplate, VendorMatch, ExtractionRules } from "./template-types.js";
import { deriveVendorKey } from "./template-types.js";

const GENERATION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function parseRules(row: typeof vendorTemplates.$inferSelect): VendorTemplate {
  return {
    id: row.id,
    vendorKey: row.vendorKey,
    vendorName: row.vendorName,
    vendorDomains: row.vendorDomains ?? [],
    vendorKeywords: row.vendorKeywords ?? [],
    extractionRules: JSON.parse(row.extractionRules) as ExtractionRules,
    successCount: row.successCount,
    failCount: row.failCount,
    lastGenerationAttempt: row.lastGenerationAttempt,
  };
}

/** Check if a template generation attempt is still in cooldown (< 7 days). */
export function isInCooldown(template: VendorTemplate): boolean {
  if (!template.lastGenerationAttempt) return false;
  return Date.now() - template.lastGenerationAttempt.getTime() < GENERATION_COOLDOWN_MS;
}

/** Returns true if the template has usable extraction rules (non-empty row regex). */
export function hasUsableRules(template: VendorTemplate): boolean {
  return !!template.extractionRules.lineItems.row;
}

export async function loadAllTemplates(): Promise<VendorTemplate[]> {
  const db = getDb();
  const rows = await db.select().from(vendorTemplates);
  return rows.map(parseRules);
}

export function detectVendor(
  text: string,
  templates: VendorTemplate[]
): VendorMatch | null {
  const textLower = text.toLowerCase();

  const domainMatches =
    text.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.[a-z]{2,})/gi) || [];
  const textDomains = new Set(
    domainMatches.map((d) =>
      d.replace(/^(?:https?:\/\/)?(?:www\.)?/i, "").toLowerCase()
    )
  );

  // Tier 1: domain match (high confidence — failures count)
  for (const tpl of templates) {
    if (tpl.vendorDomains.some((d) => textDomains.has(d.toLowerCase()))) {
      return { template: tpl, confidence: "domain" };
    }
  }

  // Tier 2: keyword match (low confidence — failures do NOT count)
  for (const tpl of templates) {
    if (tpl.vendorKeywords.some((k) => textLower.includes(k.toLowerCase()))) {
      return { template: tpl, confidence: "keyword" };
    }
  }

  return null;
}

export async function incrementSuccess(templateId: number): Promise<void> {
  const db = getDb();
  await db
    .update(vendorTemplates)
    .set({
      successCount: sql`${vendorTemplates.successCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(vendorTemplates.id, templateId));
}

export async function incrementFail(templateId: number): Promise<void> {
  const db = getDb();
  await db
    .update(vendorTemplates)
    .set({
      failCount: sql`${vendorTemplates.failCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(vendorTemplates.id, templateId));
}

export async function upsertTemplate(
  rules: ExtractionRules,
  existingId?: number
): Promise<void> {
  const db = getDb();
  const rulesJson = JSON.stringify(rules);
  const vendorKey = deriveVendorKey(rules.vendorSignals);
  const values = {
    vendorKey,
    vendorName: rules.vendorName,
    vendorDomains: rules.vendorSignals.domains,
    vendorKeywords: rules.vendorSignals.keywords,
    extractionRules: rulesJson,
    successCount: 0,
    failCount: 0,
    lastGenerationAttempt: new Date(),
    updatedAt: new Date(),
  };

  if (existingId) {
    await db
      .update(vendorTemplates)
      .set(values)
      .where(eq(vendorTemplates.id, existingId));
  } else {
    // ON CONFLICT handles race condition: two concurrent first-seen uploads
    await db
      .insert(vendorTemplates)
      .values(values)
      .onConflictDoUpdate({
        target: vendorTemplates.vendorKey,
        set: values,
      });
  }
}

/**
 * Record a failed template generation attempt. Saves a stub record so that
 * future uploads of the same vendor skip template generation for 7 days.
 */
export async function recordFailedAttempt(
  vendorName: string,
  signals: { domains: string[]; keywords: string[] }
): Promise<void> {
  const db = getDb();
  const vendorKey = deriveVendorKey(signals);
  const stubRules: ExtractionRules = {
    vendorName,
    vendorSignals: signals,
    fields: [],
    lineItems: { start: "", end: "", row: "" },
    totals: [],
  };

  await db
    .insert(vendorTemplates)
    .values({
      vendorKey,
      vendorName,
      vendorDomains: signals.domains,
      vendorKeywords: signals.keywords,
      extractionRules: JSON.stringify(stubRules),
      successCount: 0,
      failCount: 1,
      lastGenerationAttempt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: vendorTemplates.vendorKey,
      set: {
        lastGenerationAttempt: new Date(),
        failCount: sql`${vendorTemplates.failCount} + 1`,
        updatedAt: new Date(),
      },
    });
}
