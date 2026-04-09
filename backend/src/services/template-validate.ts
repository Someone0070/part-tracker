import RE2 from "re2";
import type { ExtractionRules } from "./template-types.js";
import { applyTemplate, safeMatch } from "./template-apply.js";
import type { LlmExtraction } from "./template-llm.js";

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  /** Totals rule names that failed validation (strip before saving) */
  badTotals?: string[];
}

export interface FieldFailure {
  name: string;
  type: "field" | "total";
  expected: string;
  got: string;
  /** Text snippet around where the value appears in the document */
  context: string;
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
  for (const rule of rules.fields) {
    patterns.push(rule.regex);
  }
  patterns.push(rules.lineItems.start);
  patterns.push(rules.lineItems.end);
  patterns.push(rules.lineItems.row);
  for (const total of rules.totals) {
    patterns.push(total.regex);
  }
  return patterns;
}

function literalFraction(pattern: string): number {
  const stripped = pattern.replace(/\\[dDsSwWbBtnrfv.+*?^$|{}()\[\]]/g, "");
  const withoutSyntax = stripped.replace(/[+*?.^$|{}()\[\]\\]/g, "");
  const alphanumOnly = withoutSyntax.replace(/[^a-zA-Z0-9]/g, "");
  return pattern.length > 0 ? alphanumOnly.length / pattern.length : 0;
}

/** Get ~200 chars around where a value appears in text */
function getContext(text: string, value: string): string {
  const idx = text.indexOf(value);
  if (idx === -1) return text.slice(0, 200);
  const start = Math.max(0, idx - 80);
  const end = Math.min(text.length, idx + value.length + 80);
  return text.slice(start, end);
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

  // Check totals regex -- bad ones get flagged for stripping, not rejection
  const badTotals: string[] = [];
  const subtotal = extraction.items.reduce(
    (sum, item) => sum + (item.unitPrice ?? 0) * item.quantity, 0
  );
  for (const totalRule of rules.totals) {
    const m = safeMatch(text, totalRule.regex, "s");
    const regexVal = m?.[1] ? parseFloat(m[1]) : 0;
    const llmVal = totalRule.name === "tax" ? (extraction.totalTax ?? 0)
      : totalRule.name === "shipping" ? (extraction.totalShipping ?? 0)
      : 0;

    if (regexVal > subtotal || (llmVal > 0 && Math.abs(regexVal - llmVal) > 1)) {
      badTotals.push(totalRule.name);
    }
  }

  return { valid: true, badTotals: badTotals.length > 0 ? badTotals : undefined };
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

/**
 * Identify which field/total regexes failed so they can be repaired.
 * Returns failures with the expected value and surrounding text context.
 */
export function findFieldFailures(
  text: string,
  rules: ExtractionRules,
  extraction: LlmExtraction
): FieldFailure[] {
  const failures: FieldFailure[] = [];

  const expectedFields: Record<string, string | null> = {
    orderNumber: extraction.orderNumber,
    orderDate: extraction.orderDate,
    technicianName: extraction.technicianName,
    trackingNumber: extraction.trackingNumber,
    courier: extraction.deliveryCourier,
  };

  for (const rule of rules.fields) {
    const expected = expectedFields[rule.name];
    if (!expected) continue;

    const m = safeMatch(text, rule.regex, "s");
    const got = m?.[rule.group] ?? "";

    if (got.trim() !== expected.trim()) {
      failures.push({
        name: rule.name,
        type: "field",
        expected,
        got: got || "(no match)",
        context: getContext(text, expected),
      });
    }
  }

  // Check for fields the LLM found but template has no rule for
  for (const [name, expected] of Object.entries(expectedFields)) {
    if (!expected) continue;
    if (!rules.fields.some((r) => r.name === name)) {
      failures.push({
        name,
        type: "field",
        expected,
        got: "(no rule)",
        context: getContext(text, expected),
      });
    }
  }

  const subtotal = extraction.items.reduce(
    (sum, item) => sum + (item.unitPrice ?? 0) * item.quantity, 0
  );
  const expectedTotals: Record<string, number> = {};
  if (extraction.totalTax) expectedTotals["tax"] = extraction.totalTax;
  if (extraction.totalShipping) expectedTotals["shipping"] = extraction.totalShipping;

  for (const [name, expected] of Object.entries(expectedTotals)) {
    const rule = rules.totals.find((t) => t.name === name);
    const m = rule ? safeMatch(text, rule.regex, "s") : null;
    const got = m?.[1] ? parseFloat(m[1]) : 0;

    if (Math.abs(got - expected) > 1 || got > subtotal) {
      failures.push({
        name,
        type: "total",
        expected: String(expected),
        got: rule ? String(got) : "(no rule)",
        context: getContext(text, String(expected)),
      });
    }
  }

  // Check for totals the LLM found but template has no rule for
  for (const name of Object.keys(expectedTotals)) {
    if (!rules.totals.some((t) => t.name === name)) {
      failures.push({
        name,
        type: "total",
        expected: String(expectedTotals[name]),
        got: "(no rule)",
        context: getContext(text, String(expectedTotals[name])),
      });
    }
  }

  return failures;
}
