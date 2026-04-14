import { getDb } from "../db/index.js";
import { learnedPrefixes } from "../db/schema.js";
import { sql } from "drizzle-orm";

// --- Candidacy rules ---

const BRAND_PATTERN =
  /\b(whirlpool|kenmore|ge|samsung|lg|maytag|frigidaire|bosch|kitchenaid|amana|hotpoint|electrolux|haier|hisense)\b/i;

/** Known multi-word status patterns that should be treated as single prefixes */
const MULTI_WORD_PREFIXES = [
  "IN STOCK",
  "OUT OF STOCK",
  "ON ORDER",
  "BACK ORDERED",
  "ON BACK ORDER",
];

/**
 * Extract a candidate prefix from the difference between template and nano partNames.
 * Returns null if the difference doesn't pass candidacy rules.
 */
export function extractCandidatePrefix(
  templateName: string,
  nanoName: string
): string | null {
  const tpl = templateName.trim();
  const nano = nanoName.trim();

  if (tpl.length === 0 || nano.length === 0) return null;
  if (tpl.length <= nano.length) return null;

  // Check multi-word patterns first
  const tplUpper = tpl.toUpperCase();
  for (const mw of MULTI_WORD_PREFIXES) {
    if (tplUpper.startsWith(mw + " ")) {
      // Verify the rest matches nano (approximately)
      const rest = tpl.slice(mw.length).trim();
      if (rest.toLowerCase().includes(nano.toLowerCase().slice(0, Math.min(nano.length, 8)))) {
        return mw;
      }
    }
  }

  // Single-word prefix: first word of template that nano doesn't start with
  const tplWords = tpl.split(/\s+/);
  if (tplWords.length < 2) return null;

  const candidate = tplWords[0];

  // Candidacy rules from spec:
  // 1. Must be all-uppercase
  if (candidate !== candidate.toUpperCase()) return null;
  // 2. Must not contain digits
  if (/\d/.test(candidate)) return null;
  // 3. Must be 2-15 characters
  if (candidate.length < 2 || candidate.length > 15) return null;
  // 4. Must not be a known brand name
  if (BRAND_PATTERN.test(candidate)) return null;

  // Verify the rest of the template roughly matches nano
  const rest = tplWords.slice(1).join(" ");
  const nanoStart = nano.slice(0, Math.min(nano.length, 8)).toLowerCase();
  if (!rest.toLowerCase().includes(nanoStart)) return null;

  return candidate;
}

/**
 * Compare template items vs nano items and learn any candidate prefixes.
 * Inserts new prefixes or increments hit_count for existing ones.
 */
export async function learnPrefixes(
  templateItems: Array<{ partNumber: string; partName?: string | null }>,
  nanoItems: Array<{ partNumber: string; partName?: string | null }>,
  sourceVendor: string
): Promise<string[]> {
  const learned: string[] = [];

  for (const nanoItem of nanoItems) {
    if (!nanoItem.partName || nanoItem.partName.trim().length === 0) continue;
    const tplItem = templateItems.find((t) => t.partNumber === nanoItem.partNumber);
    if (!tplItem?.partName) continue;

    const prefix = extractCandidatePrefix(tplItem.partName, nanoItem.partName);
    if (prefix && !learned.includes(prefix)) {
      learned.push(prefix);
    }
  }

  if (learned.length === 0) return [];

  // Upsert each learned prefix
  const db = getDb();
  for (const prefix of learned) {
    await db
      .insert(learnedPrefixes)
      .values({ prefix, sourceVendor })
      .onConflictDoUpdate({
        target: learnedPrefixes.prefix,
        set: { hitCount: sql`${learnedPrefixes.hitCount} + 1` },
      });
  }

  console.log(`[LearnedPrefixes] learned ${learned.length} prefix(es): ${learned.join(", ")} from ${sourceVendor}`);
  return learned;
}

// --- Cached prefix loading ---

interface PrefixCache {
  prefixes: string[];
  loadedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let prefixCache: PrefixCache | null = null;

/**
 * Load all activated prefixes (hit_count >= 3) from DB.
 * Cached in memory with 5-minute TTL.
 */
export async function loadActivePrefixes(): Promise<string[]> {
  const now = Date.now();
  if (prefixCache && now - prefixCache.loadedAt < CACHE_TTL_MS) {
    return prefixCache.prefixes;
  }

  const db = getDb();
  const rows = await db
    .select({ prefix: learnedPrefixes.prefix })
    .from(learnedPrefixes)
    .where(sql`${learnedPrefixes.hitCount} >= 3`);

  const prefixes = rows.map((r) => r.prefix);
  prefixCache = { prefixes, loadedAt: now };
  return prefixes;
}

/** Clear the prefix cache (for testing or after learning new prefixes) */
export function clearPrefixCache(): void {
  prefixCache = null;
}

// --- Batched hit count updates ---

const hitCountBuffer = new Map<string, number>();
let flushTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Record a hit for a prefix (batched -- not written to DB immediately).
 * Call flushHitCounts() to write accumulated counts.
 */
export function recordPrefixHit(prefix: string): void {
  hitCountBuffer.set(prefix, (hitCountBuffer.get(prefix) ?? 0) + 1);

  // Start flush timer if not already running
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      flushHitCounts().catch((err) => {
        console.warn("[LearnedPrefixes] flush error:", err);
      });
    }, CACHE_TTL_MS); // Flush every 5 minutes, same cadence as cache TTL
    // Don't keep process alive just for this timer
    if (flushTimer && typeof flushTimer === "object" && "unref" in flushTimer) {
      flushTimer.unref();
    }
  }
}

/**
 * Flush accumulated hit counts to the database.
 * Called periodically and on process shutdown.
 */
export async function flushHitCounts(): Promise<void> {
  if (hitCountBuffer.size === 0) return;

  // Snapshot and clear buffer atomically
  const entries = [...hitCountBuffer.entries()];
  hitCountBuffer.clear();

  const db = getDb();
  for (const [prefix, count] of entries) {
    try {
      await db
        .update(learnedPrefixes)
        .set({ hitCount: sql`${learnedPrefixes.hitCount} + ${count}` })
        .where(sql`${learnedPrefixes.prefix} = ${prefix}`);
    } catch (err) {
      console.warn(`[LearnedPrefixes] failed to flush hit count for "${prefix}":`, err);
    }
  }
}

/**
 * Build a regex that matches any known prefix (hardcoded + learned) at the start of a string.
 * Returns null if no prefixes are available.
 */
export function buildPrefixRegex(learnedPrefixes: string[]): RegExp {
  // Hardcoded prefixes (always present, even if DB is empty)
  const hardcoded = [
    "SHIPPED",
    "B\\/O",
    "BACKORDERED",
    "BACK\\s*ORDER(?:ED)?",
    "IN\\s*STOCK",
    "OUT\\s*OF\\s*STOCK",
    "PENDING",
    "ON\\s*ORDER",
  ];

  // Escape learned prefixes for regex and deduplicate against hardcoded
  const hardcodedPlain = new Set(["SHIPPED", "B/O", "BACKORDERED", "BACK ORDERED", "IN STOCK", "OUT OF STOCK", "PENDING", "ON ORDER"]);
  const additional = learnedPrefixes
    .filter((p) => !hardcodedPlain.has(p))
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  const allPatterns = [...hardcoded, ...additional];
  return new RegExp(`^(${allPatterns.join("|")})\\s+`, "i");
}
