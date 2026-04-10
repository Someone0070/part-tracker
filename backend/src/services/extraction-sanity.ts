import type { DocumentResult, ExtractedItem } from "./template-types.js";

export interface SanityResult {
  pass: boolean;
  score: number;
  failures: string[];
}

/**
 * Free sanity checks on template-extracted data.
 * Catches wrong regex grabs without any LLM calls.
 * Returns a score 0-100 and specific failure reasons.
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

    // --- Part number looks part-numbery ---
    if (!item.partNumber || item.partNumber.trim().length < 2) {
      failures.push(`${label}: missing or too-short part number`);
      score -= 25;
    } else if (!/[A-Z0-9]/i.test(item.partNumber)) {
      failures.push(`${label}: part number "${item.partNumber}" has no alphanumeric chars`);
      score -= 20;
    } else if (/^\d{1,2}$/.test(item.partNumber)) {
      // Grabbed a quantity or sequence number instead of a part number
      failures.push(`${label}: part number "${item.partNumber}" looks like a number, not a part`);
      score -= 25;
    }

    // --- Price sanity ---
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

    // --- Quantity sanity ---
    if (item.quantity <= 0) {
      failures.push(`${label}: quantity is ${item.quantity}`);
      score -= 20;
    } else if (!Number.isInteger(item.quantity)) {
      failures.push(`${label}: quantity ${item.quantity} is not a whole number`);
      score -= 10;
    }

    // --- Ship/tax not bigger than unit price ---
    if (item.unitPrice != null && item.unitPrice > 0) {
      if ((item.shipCost ?? 0) > item.unitPrice * item.quantity * 2) {
        failures.push(`${label}: shipping $${item.shipCost} exceeds 2x line total`);
        score -= 15;
      }
      if ((item.taxPrice ?? 0) > item.unitPrice * item.quantity) {
        failures.push(`${label}: tax $${item.taxPrice} exceeds line total`);
        score -= 15;
      }
    }
  }

  // --- Arithmetic check: do the numbers add up? ---
  const subtotal = result.items.reduce(
    (s, i) => s + (i.unitPrice ?? 0) * i.quantity, 0
  );
  const totalTax = result.items.reduce(
    (s, i) => s + (i.taxPrice ?? 0) * i.quantity, 0
  );
  const totalShip = result.items.reduce(
    (s, i) => s + (i.shipCost ?? 0) * i.quantity, 0
  );

  // Check if any individual item has a line total that looks wrong
  // (unit price grabbed from wrong column -- e.g., picked up quantity as price)
  for (let i = 0; i < result.items.length; i++) {
    const item = result.items[i];
    if (item.unitPrice != null && item.unitPrice > 0 && item.unitPrice === item.quantity) {
      // Price equals quantity -- very suspicious, likely column swap
      failures.push(`Item ${i + 1}: unit price equals quantity (${item.unitPrice}) -- possible column swap`);
      score -= 15;
    }
  }

  // --- Date sanity ---
  if (result.orderDate) {
    const d = new Date(result.orderDate);
    if (isNaN(d.getTime())) {
      failures.push(`Order date "${result.orderDate}" is not a valid date`);
      score -= 10;
    } else {
      const now = Date.now();
      const twoYearsAgo = now - 2 * 365 * 24 * 60 * 60 * 1000;
      const oneWeekAhead = now + 7 * 24 * 60 * 60 * 1000;
      if (d.getTime() < twoYearsAgo || d.getTime() > oneWeekAhead) {
        failures.push(`Order date ${result.orderDate} is outside reasonable range`);
        score -= 10;
      }
    }
  }

  // --- Duplicate value check: different fields shouldn't have the same value ---
  const fieldValues = [
    result.orderNumber,
    result.orderDate,
    result.trackingNumber,
    result.technicianName,
  ].filter(Boolean) as string[];
  const dupes = fieldValues.filter((v, i) => fieldValues.indexOf(v) !== i);
  if (dupes.length > 0) {
    failures.push(`Duplicate values across fields: ${dupes.join(", ")}`);
    score -= 15;
  }

  // --- Part number collision with metadata ---
  const partNumbers = new Set(result.items.map((i) => i.partNumber));
  if (result.orderNumber && partNumbers.has(result.orderNumber)) {
    failures.push(`Order number "${result.orderNumber}" is also a part number -- likely wrong`);
    score -= 15;
  }
  if (result.trackingNumber && partNumbers.has(result.trackingNumber)) {
    failures.push(`Tracking number "${result.trackingNumber}" is also a part number -- likely wrong`);
    score -= 15;
  }

  score = Math.max(0, score);

  return {
    pass: score >= 50,
    score,
    failures,
  };
}
