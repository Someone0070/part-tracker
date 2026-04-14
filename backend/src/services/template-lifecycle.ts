import { getDb } from "../db/index.js";
import { vendorTemplates } from "../db/schema.js";
import { eq, and, sql, desc } from "drizzle-orm";
import type { ExtractionRules } from "./template-types.js";

export interface RecentResult {
  pass: boolean | null; // null = unverified
  ts: string;           // ISO8601
}

// Pure functions

export function appendResult(results: RecentResult[], pass: boolean | null): RecentResult[] {
  const next = [...results, { pass, ts: new Date().toISOString() }];
  if (next.length > 10) {
    return next.slice(next.length - 10);
  }
  return next;
}

export function shouldEvict(results: RecentResult[]): boolean {
  const scored = results.filter((r) => r.pass !== null);
  if (scored.length < 5) return false;
  const passes = scored.filter((r) => r.pass === true).length;
  return passes === 0;
}

export function findWeakestVersion(
  versions: Array<{ id: number; recentResults: RecentResult[] }>
): number {
  const MIN_SAMPLE = 5;

  const withStats = versions.map((v) => {
    const scored = v.recentResults.filter((r) => r.pass !== null);
    const passes = scored.filter((r) => r.pass === true).length;
    const aboveMin = scored.length >= MIN_SAMPLE;
    const passRate = aboveMin ? passes / scored.length : 0;
    return { id: v.id, aboveMin, passRate };
  });

  // Below-min-sample versions are always weaker than above-min-sample versions.
  // Among versions in the same tier, pick lowest pass rate.
  // Tie-break: first encountered (stable).

  const belowMin = withStats.filter((v) => !v.aboveMin);
  const aboveMin = withStats.filter((v) => v.aboveMin);

  if (belowMin.length > 0 && aboveMin.length === 0) {
    // All below min — return the one with lowest pass rate (they all have passRate 0,
    // so just return first).
    return belowMin[0].id;
  }

  if (belowMin.length > 0) {
    // There are some above-min versions; below-min versions are weaker — return first below-min.
    return belowMin[0].id;
  }

  // All above min: lowest pass rate.
  let weakest = aboveMin[0];
  for (let i = 1; i < aboveMin.length; i++) {
    if (aboveMin[i].passRate < weakest.passRate) {
      weakest = aboveMin[i];
    }
  }
  return weakest.id;
}

export function needsSpotCheck(results: RecentResult[]): boolean {
  // If any result has pass === true, no spot check needed.
  if (results.some((r) => r.pass === true)) return false;

  // Count consecutive unverified (null) from the end.
  let count = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].pass === null) {
      count++;
    } else {
      break;
    }
  }
  return count >= 5;
}

// DB functions

export async function createTemplateVersion(
  vendorKey: string,
  rules: ExtractionRules
): Promise<number> {
  const db = getDb();

  return await db.transaction(async (tx) => {
    // Serialize per vendor via advisory lock.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${vendorKey}))`);

    // Get current max version for this vendor.
    const maxResult = await tx.execute(
      sql`SELECT COALESCE(MAX(version), 0) AS max_version FROM vendor_templates WHERE vendor_key = ${vendorKey}`
    );
    const maxVersion = Number((maxResult.rows[0] as { max_version: string | number }).max_version);
    const newVersion = maxVersion + 1;

    // Insert the new template.
    const inserted = await tx
      .insert(vendorTemplates)
      .values({
        vendorKey,
        vendorName: rules.vendorName,
        vendorDomains: rules.vendorSignals.domains,
        vendorKeywords: rules.vendorSignals.keywords,
        extractionRules: JSON.stringify(rules),
        version: newVersion,
        recentResults: "[]",
        status: "active",
      })
      .returning({ id: vendorTemplates.id });

    const newId = inserted[0].id;

    // Cap enforcement: if >3 active versions for this vendor, mark weakest as dead.
    const activeVersions = await tx
      .select({
        id: vendorTemplates.id,
        recentResults: vendorTemplates.recentResults,
      })
      .from(vendorTemplates)
      .where(and(eq(vendorTemplates.vendorKey, vendorKey), eq(vendorTemplates.status, "active")))
      .orderBy(desc(vendorTemplates.version));

    if (activeVersions.length > 3) {
      const versionsWithParsed = activeVersions.map((v) => ({
        id: v.id,
        recentResults: JSON.parse(v.recentResults) as RecentResult[],
      }));
      const weakestId = findWeakestVersion(versionsWithParsed);
      await tx
        .update(vendorTemplates)
        .set({ status: "dead" })
        .where(eq(vendorTemplates.id, weakestId));
    }

    return newId;
  });
}

export async function recordResult(templateId: number, pass: boolean | null): Promise<void> {
  const db = getDb();

  const rows = await db
    .select({
      recentResults: vendorTemplates.recentResults,
      successCount: vendorTemplates.successCount,
      failCount: vendorTemplates.failCount,
    })
    .from(vendorTemplates)
    .where(eq(vendorTemplates.id, templateId));

  if (rows.length === 0) {
    throw new Error(`Template ${templateId} not found`);
  }

  const row = rows[0];
  const current: RecentResult[] = JSON.parse(row.recentResults);
  const updated = appendResult(current, pass);

  const successCountDelta = pass === true ? 1 : 0;
  const failCountDelta = pass === false ? 1 : 0;

  const evict = shouldEvict(updated);

  await db
    .update(vendorTemplates)
    .set({
      recentResults: JSON.stringify(updated),
      successCount: row.successCount + successCountDelta,
      failCount: row.failCount + failCountDelta,
      ...(evict ? { status: "dead" } : {}),
      updatedAt: new Date(),
    })
    .where(eq(vendorTemplates.id, templateId));
}

export async function loadActiveVersions(vendorKey: string): Promise<
  Array<{
    id: number;
    vendorKey: string;
    version: number;
    recentResults: RecentResult[];
    status: string;
    successCount: number;
    failCount: number;
  }>
> {
  const db = getDb();

  const rows = await db
    .select({
      id: vendorTemplates.id,
      vendorKey: vendorTemplates.vendorKey,
      version: vendorTemplates.version,
      recentResults: vendorTemplates.recentResults,
      status: vendorTemplates.status,
      successCount: vendorTemplates.successCount,
      failCount: vendorTemplates.failCount,
    })
    .from(vendorTemplates)
    .where(and(eq(vendorTemplates.vendorKey, vendorKey), eq(vendorTemplates.status, "active")))
    .orderBy(desc(vendorTemplates.version));

  return rows.map((r) => ({
    ...r,
    recentResults: JSON.parse(r.recentResults) as RecentResult[],
  }));
}
