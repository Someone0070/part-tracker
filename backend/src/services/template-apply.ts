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

function extractTotal(text: string, pattern: string | undefined): number {
  if (!pattern) return 0;
  const m = safeMatch(text, pattern, "s");
  return m?.[1] ? parseFloat(m[1]) : 0;
}

export function applyTemplate(
  text: string,
  rules: ExtractionRules
): DocumentResult {
  // 1. Extract scalar fields
  const fields: Record<string, string | null> = {};
  for (const [name, rule] of Object.entries(rules.fields)) {
    const m = safeMatch(text, rule.regex, "s");
    fields[name] = m?.[rule.group] ?? null;
  }

  // 2. Extract line items between start/end markers
  const items: ExtractedItem[] = [];
  const startMatch = safeMatch(text, rules.lineItems.start, "i");

  if (startMatch && startMatch.index != null) {
    const afterStart = text.slice(startMatch.index + startMatch[0].length);
    const endMatch = safeMatch(afterStart, rules.lineItems.end, "i");
    const tableText = endMatch && endMatch.index != null
      ? afterStart.slice(0, endMatch.index)
      : afterStart;

    try {
      const rowRe = new RE2(rules.lineItems.row, "g");
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
      // Invalid row pattern -- return 0 items (triggers LLM fallback)
    }
  }

  // 3. Extract totals and distribute proportionally
  const tax = extractTotal(text, rules.totals["tax"]);
  const shipping = extractTotal(text, rules.totals["shipping"]);

  if (tax > 0 || shipping > 0) {
    distributeAndNormalize(items, shipping, tax);
  }

  return {
    vendor: rules.vendorName,
    orderNumber: fields["orderNumber"] ?? null,
    orderDate: fields["orderDate"] ?? null,
    technicianName: fields["technicianName"] ?? null,
    trackingNumber: fields["trackingNumber"] ?? null,
    deliveryCourier: fields["courier"] ?? null,
    items,
    rawText: text,
  };
}
