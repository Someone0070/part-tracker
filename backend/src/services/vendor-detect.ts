import { getDb } from "../db/index.js";
import { vendorTemplates } from "../db/schema.js";
import { eq, desc } from "drizzle-orm";
import type { VendorTemplate, VendorMatchResult, ExtractionRules } from "./template-types.js";

const GENERATION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function parseRules(row: typeof vendorTemplates.$inferSelect): VendorTemplate {
  return {
    id: row.id,
    vendorKey: row.vendorKey,
    vendorName: row.vendorName,
    vendorDomains: row.vendorDomains ?? [],
    vendorKeywords: row.vendorKeywords ?? [],
    extractionRules: JSON.parse(row.extractionRules) as ExtractionRules,
    version: row.version,
    status: row.status,
    recentResults: row.recentResults,
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

export async function loadAllActiveTemplates(): Promise<VendorTemplate[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(vendorTemplates)
    .where(eq(vendorTemplates.status, "active"))
    .orderBy(desc(vendorTemplates.version));
  return rows.map(parseRules);
}

export function detectVendorVersions(
  text: string,
  templates: VendorTemplate[]
): VendorMatchResult | null {
  const domainMatches =
    text.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.[a-z]{2,})/gi) || [];
  const textDomains = new Set(
    domainMatches.map((d) =>
      d.replace(/^(?:https?:\/\/)?(?:www\.)?/i, "").toLowerCase()
    )
  );

  // Tier 1: domain match (high confidence)
  for (const tpl of templates) {
    if (tpl.vendorDomains.some((d) => textDomains.has(d.toLowerCase()))) {
      const vendorKey = tpl.vendorKey;
      const allVersions = templates.filter((t) => t.vendorKey === vendorKey);
      return { vendorKey, confidence: "domain", templates: allVersions };
    }
  }

  // Tier 2: keyword match (low confidence)
  // Keywords must be 4+ chars and match as whole words to avoid false positives
  for (const tpl of templates) {
    const matched = tpl.vendorKeywords.some((k) => {
      if (k.length < 4) return false;
      const escaped = k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`, "i").test(text);
    });
    if (matched) {
      const vendorKey = tpl.vendorKey;
      const allVersions = templates.filter((t) => t.vendorKey === vendorKey);
      return { vendorKey, confidence: "keyword", templates: allVersions };
    }
  }

  return null;
}
