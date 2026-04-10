import RE2 from "re2";
import type { ExtractedItem, ExtractionRules, DocumentResult } from "./template-types.js";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function distributeAndNormalize(
  items: ExtractedItem[],
  totalShipping: number,
  totalTax: number
): void {
  const subtotal = items.reduce(
    (sum, item) => sum + (item.unitPrice ?? 0) * item.quantity,
    0
  );

  for (const item of items) {
    const lineTotal = (item.unitPrice ?? 0) * item.quantity;
    const fraction = subtotal > 0 ? lineTotal / subtotal : 1 / items.length;

    const lineShip = round2(totalShipping * fraction);
    const lineTax = round2(totalTax * fraction);

    const qty = item.quantity || 1;
    item.unitPrice = item.unitPrice != null ? round2(item.unitPrice) : null;
    item.shipCost = round2(lineShip / qty);
    item.taxPrice = round2(lineTax / qty);
  }
}

export function safeMatch(text: string, pattern: string, flags = ""): RegExpMatchArray | null {
  try {
    const re = new RE2(pattern, flags);
    return text.match(re);
  } catch {
    return null;
  }
}

/**
 * Apply a template to extract line items only.
 * Metadata (order number, dates, tracking, totals) always comes from nano fill-in.
 */
function extractRows(tableText: string, rowPattern: string): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  try {
    const rowRe = new RE2(rowPattern, "g");
    let match;
    while ((match = rowRe.exec(tableText)) !== null) {
      const g = match.groups as Record<string, string> | undefined;
      if (!g) continue;
      if (/payment/i.test(match[0])) continue;

      items.push({
        partNumber: g["partNumber"]?.trim() ?? "",
        partName: (g["description"] ?? g["partName"] ?? "").trim(),
        quantity: parseInt(g["quantity"]) || 1,
        unitPrice: g["unitPrice"] ? parseFloat(g["unitPrice"]) : null,
        shipCost: null,
        taxPrice: null,
        brand: g["brand"]?.trim() ?? null,
      });
    }
  } catch {
    // Invalid row pattern
  }
  return items;
}

/**
 * Apply a template to extract line items only.
 * Metadata (order number, dates, tracking, totals) always comes from nano fill-in.
 */
export function applyTemplate(
  text: string,
  rules: ExtractionRules
): DocumentResult {
  let items: ExtractedItem[] = [];
  const startMatch = safeMatch(text, rules.lineItems.start, "i");

  if (startMatch && startMatch.index != null) {
    const afterStart = text.slice(startMatch.index + startMatch[0].length);
    const endMatch = safeMatch(afterStart, rules.lineItems.end, "i");
    const tableText = endMatch && endMatch.index != null
      ? afterStart.slice(0, endMatch.index)
      : afterStart;

    items = extractRows(tableText, rules.lineItems.row);

    // Reversed layout fallback: if start/end matched but the table region
    // was too small or yielded 0 items, try searching the full document.
    // Some PDFs (e.g. Encompass) have items BEFORE the header in extracted text.
    if (items.length === 0 && tableText.length < 100) {
      items = extractRows(text, rules.lineItems.row);
    }
  } else {
    // No start match -- try row regex on full text as last resort
    items = extractRows(text, rules.lineItems.row);
  }

  return {
    vendor: rules.vendorName,
    orderNumber: null,
    orderDate: null,
    technicianName: null,
    trackingNumber: null,
    deliveryCourier: null,
    items,
    rawText: text,
  };
}
