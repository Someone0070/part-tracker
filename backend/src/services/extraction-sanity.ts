import type { DocumentResult } from "./template-types.js";

export interface SanityResult {
  pass: boolean;
  score: number;
  failures: string[];
}

/**
 * Sanity checks on template-extracted item data.
 * Only validates items (part numbers, prices, quantities) --
 * metadata and totals come from nano fill-in and aren't checked here.
 */
export function checkExtraction(result: DocumentResult): SanityResult {
  const failures: string[] = [];
  let score = 100;

  if (result.items.length === 0) {
    return { pass: false, score: 0, failures: ["No items extracted"] };
  }

  for (let i = 0; i < result.items.length; i++) {
    const item = result.items[i];
    const label = result.items.length > 1 ? `Item ${i + 1}` : "Item";

    // Part number looks part-numbery
    if (!item.partNumber || item.partNumber.trim().length < 2) {
      failures.push(`${label}: missing or too-short part number`);
      score -= 25;
    } else if (!/[A-Z0-9]/i.test(item.partNumber)) {
      failures.push(`${label}: part number "${item.partNumber}" has no alphanumeric chars`);
      score -= 20;
    } else if (/^\d{1,2}$/.test(item.partNumber)) {
      failures.push(`${label}: part number "${item.partNumber}" looks like a number, not a part`);
      score -= 25;
    }

    // Price sanity
    if (item.unitPrice != null) {
      if (item.unitPrice < 0) {
        failures.push(`${label}: negative unit price ${item.unitPrice}`);
        score -= 20;
      }
      if (item.unitPrice > 50_000) {
        failures.push(`${label}: unit price ${item.unitPrice} seems unreasonably high`);
        score -= 10;
      }
    }

    // Quantity sanity
    if (item.quantity <= 0) {
      failures.push(`${label}: quantity is ${item.quantity}`);
      score -= 20;
    } else if (!Number.isInteger(item.quantity)) {
      failures.push(`${label}: quantity ${item.quantity} is not a whole number`);
      score -= 10;
    }

    // Price equals quantity -- likely column swap
    if (item.unitPrice != null && item.unitPrice > 0 && item.unitPrice === item.quantity) {
      failures.push(`${label}: unit price equals quantity (${item.unitPrice}) -- possible column swap`);
      score -= 15;
    }
  }

  score = Math.max(0, score);

  return {
    pass: score >= 50,
    score,
    failures,
  };
}
