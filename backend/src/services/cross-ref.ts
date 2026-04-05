import { getDb } from "../db/index.js";
import { crossReferences, settings } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { normalizePartNumber } from "./normalize.js";

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";

const PART_NUMBER_REGEX = /\b(?:WP[A-Z]?\d{5,}|W\d{7,}|WB\d+X\d+|\d{7,10}|[A-Z]{2,3}\d{6,})\b/gi;
const CATALOG_PREFIX_REGEX = /^(?:AP|PS|EA)\d+$/i;

interface BraveSearchResult {
  web?: {
    results?: Array<{
      title: string;
      description: string;
      url: string;
    }>;
  };
}

async function braveSearch(query: string, apiKey: string): Promise<BraveSearchResult> {
  const url = new URL(BRAVE_API_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("count", "10");

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<BraveSearchResult>;
}

function extractPartNumbers(text: string): string[] {
  const matches = text.match(PART_NUMBER_REGEX) || [];
  return matches
    .map((m) => normalizePartNumber(m))
    .filter((pn) => !CATALOG_PREFIX_REGEX.test(pn));
}

function classifyRelationship(snippet: string, partNumber: string): string {
  const lower = snippet.toLowerCase();
  const pnLower = partNumber.toLowerCase();

  const replacesIdx = lower.indexOf("replaces");
  const replacedByIdx = lower.indexOf("replaced by");
  const pnIdx = lower.indexOf(pnLower);

  if (replacedByIdx !== -1) return "replaced_by";
  if (replacesIdx !== -1 && pnIdx !== -1 && pnIdx < replacesIdx) return "replaces";
  if (replacesIdx !== -1) return "replaced_by";

  return "compatible";
}

export async function lookupCrossReferences(
  partId: number,
  partNumber: string,
  brand?: string | null,
): Promise<void> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    console.warn("BRAVE_API_KEY not set, skipping cross-ref lookup");
    return;
  }

  const db = getDb();
  const [settingsRow] = await db.select({ crossRefEnabled: settings.crossRefEnabled }).from(settings).limit(1);
  if (!settingsRow?.crossRefEnabled) return;

  const queries = [
    `"${partNumber}" replaces`,
    `"${partNumber}" cross reference`,
  ];
  if (brand) {
    queries.push(`"${partNumber}" ${brand} replaces`);
  }

  const refMap = new Map<string, { count: number; sourceUrls: Set<string>; relationship: string }>();
  const normalizedSelf = normalizePartNumber(partNumber);

  for (const query of queries) {
    try {
      const result = await braveSearch(query, apiKey);
      const webResults = result.web?.results || [];

      for (const item of webResults) {
        const text = `${item.title} ${item.description}`;
        const extracted = extractPartNumbers(text);

        for (const pn of extracted) {
          if (pn === normalizedSelf) continue;

          const existing = refMap.get(pn);
          if (existing) {
            existing.count++;
            existing.sourceUrls.add(item.url);
          } else {
            refMap.set(pn, {
              count: 1,
              sourceUrls: new Set([item.url]),
              relationship: classifyRelationship(item.description, partNumber),
            });
          }
        }
      }

      // Rate limit: 1 query/second for Brave free tier
      await new Promise((resolve) => setTimeout(resolve, 1100));
    } catch (err) {
      console.error(`Brave Search query failed for "${query}":`, err);
    }
  }

  const validated = Array.from(refMap.entries()).filter(([_, data]) => data.count >= 2);

  for (const [crossRefPn, data] of validated) {
    try {
      const sourceUrl = Array.from(data.sourceUrls)[0];

      await db
        .insert(crossReferences)
        .values({
          partId,
          crossRefPartNumber: crossRefPn,
          relationship: data.relationship,
          sourceUrl,
        })
        .onConflictDoNothing();
    } catch (err) {
      console.error(`Failed to save cross-ref ${crossRefPn} for part ${partId}:`, err);
    }
  }

  console.log(`Cross-ref lookup for ${partNumber}: found ${validated.length} validated references`);
}
