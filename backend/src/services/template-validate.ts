import RE2 from "re2";
import type { ExtractionRules } from "./template-types.js";
import { applyTemplate } from "./template-apply.js";

interface LlmExtraction {
  vendor: string;
  orderNumber: string | null;
  orderDate: string | null;
  technicianName: string | null;
  trackingNumber: string | null;
  deliveryCourier: string | null;
  items: Array<{
    partNumber: string;
    partName: string;
    quantity: number;
    unitPrice: number | null;
    brand: string | null;
  }>;
}

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

function collectLiterals(extraction: LlmExtraction): string[] {
  const literals: string[] = [];
  if (extraction.orderNumber) literals.push(extraction.orderNumber);
  if (extraction.orderDate) literals.push(extraction.orderDate);
  if (extraction.technicianName) literals.push(extraction.technicianName);
  if (extraction.trackingNumber) literals.push(extraction.trackingNumber);
  if (extraction.deliveryCourier) literals.push(extraction.deliveryCourier);
  for (const item of extraction.items) {
    if (item.partNumber) literals.push(item.partNumber);
    if (item.partName && item.partName.length > 3) literals.push(item.partName);
    if (item.unitPrice != null) literals.push(String(item.unitPrice));
  }
  return literals.filter((v) => v.length > 2);
}

function collectPatterns(rules: ExtractionRules): string[] {
  const patterns: string[] = [];
  for (const rule of Object.values(rules.fields)) {
    patterns.push(rule.regex);
  }
  patterns.push(rules.lineItems.start);
  patterns.push(rules.lineItems.end);
  patterns.push(rules.lineItems.row);
  for (const pattern of Object.values(rules.totals)) {
    patterns.push(pattern);
  }
  return patterns;
}

function literalFraction(pattern: string): number {
  const stripped = pattern.replace(/\\[dDsSwWbBtnrfv.+*?^$|{}()\[\]]/g, "");
  const withoutSyntax = stripped.replace(/[+*?.^$|{}()\[\]\\]/g, "");
  const alphanumOnly = withoutSyntax.replace(/[^a-zA-Z0-9]/g, "");
  return pattern.length > 0 ? alphanumOnly.length / pattern.length : 0;
}

function validateStructure(
  rules: ExtractionRules,
  extraction: LlmExtraction
): ValidationResult {
  const patterns = collectPatterns(rules);
  const literals = collectLiterals(extraction);

  for (const pattern of patterns) {
    try {
      new RE2(pattern);
    } catch (err) {
      return { valid: false, reason: `RE2 incompatible pattern: ${pattern} -- ${err}` };
    }
  }

  for (const literal of literals) {
    for (const pattern of patterns) {
      if (pattern.includes(literal)) {
        return { valid: false, reason: `Pattern contains literal value "${literal}": ${pattern}` };
      }
    }
  }

  const row = rules.lineItems.row;
  const requiredGroups = ["partNumber", "quantity", "unitPrice"];
  for (const group of requiredGroups) {
    if (!row.includes(`(?<${group}>`)) {
      return { valid: false, reason: `Row regex missing named group: ${group}` };
    }
  }

  // Only apply literal heuristic to row regex (field patterns naturally contain label text)
  const rowFrac = literalFraction(rules.lineItems.row);
  if (rowFrac > 0.4) {
    return { valid: false, reason: `Row regex is ${Math.round(rowFrac * 100)}% literal: ${rules.lineItems.row}` };
  }

  return { valid: true };
}

function validateExtraction(
  text: string,
  rules: ExtractionRules,
  extraction: LlmExtraction
): ValidationResult {
  const result = applyTemplate(text, rules);

  if (result.items.length < extraction.items.length) {
    return {
      valid: false,
      reason: `Template extracted ${result.items.length} items, LLM extracted ${extraction.items.length}`,
    };
  }

  const templatePNs = new Set(result.items.map((i) => i.partNumber));
  const llmPNs = extraction.items.map((i) => i.partNumber).filter(Boolean);
  for (const pn of llmPNs) {
    if (!templatePNs.has(pn)) {
      return { valid: false, reason: `Template missing part number: ${pn}` };
    }
  }

  for (const llmItem of extraction.items) {
    if (llmItem.unitPrice == null) continue;
    const tplItem = result.items.find((i) => i.partNumber === llmItem.partNumber);
    if (!tplItem || tplItem.unitPrice == null) continue;
    if (Math.abs(tplItem.unitPrice - llmItem.unitPrice) > 0.01) {
      return {
        valid: false,
        reason: `Price mismatch for ${llmItem.partNumber}: template=${tplItem.unitPrice}, llm=${llmItem.unitPrice}`,
      };
    }
  }

  return { valid: true };
}

export function validateTemplate(
  text: string,
  rules: ExtractionRules,
  extraction: LlmExtraction
): ValidationResult {
  const structural = validateStructure(rules, extraction);
  if (!structural.valid) return structural;

  return validateExtraction(text, rules, extraction);
}
