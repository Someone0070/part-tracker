import { getDb } from "../db/index.js";
import { vendorTemplates } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import type { VendorTemplate, VendorMatch, ExtractionRules } from "./template-types.js";
import { deriveVendorKey } from "./template-types.js";

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
  };
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
