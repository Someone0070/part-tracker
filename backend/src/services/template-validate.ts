import RE2 from "re2";
import type { ExtractionRules } from "./template-types.js";
import { applyTemplate, safeMatch } from "./template-apply.js";
import type { LlmExtraction } from "./template-llm.js";

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

function collectLiterals(extraction: LlmExtraction): string[] {
  const literals: string[] = [];
  for (const item of extraction.items) {
    if (item.partNumber) literals.push(item.partNumber);
    if (item.partName && item.partName.length > 3) literals.push(item.partName);
    if (item.unitPrice != null) literals.push(String(item.unitPrice));
  }
  return literals.filter((v) => v.length > 2);
}

function literalFraction(pattern: string): number {
  const stripped = pattern.replace(/\\[dDsSwWbBtnrfv.+*?^$|{}()\[\]]/g, "");
  const withoutSyntax = stripped.replace(/[+*?.^$|{}()\[\]\\]/g, "");
  const alphanumOnly = withoutSyntax.replace(/[^a-zA-Z0-9]/g, "");
  return pattern.length > 0 ? alphanumOnly.length / pattern.length : 0;
}

/**
 * Validate a template's item extraction capability.
 * Only checks line item regex -- metadata/totals are handled by nano fill-in.
 */
export function validateTemplate(
  text: string,
  rules: ExtractionRules,
  extraction: LlmExtraction
): ValidationResult {
  // Check RE2 compatibility
  const patterns = [rules.lineItems.start, rules.lineItems.end, rules.lineItems.row];
  for (const pattern of patterns) {
    try {
      new RE2(pattern);
    } catch (err) {
      return { valid: false, reason: `RE2 incompatible pattern: ${pattern} -- ${err}` };
    }
  }

  // Check for hardcoded literals in row regex
  const literals = collectLiterals(extraction);
  for (const literal of literals) {
    if (rules.lineItems.row.includes(literal)) {
      return { valid: false, reason: `Row regex contains literal value "${literal}": ${rules.lineItems.row}` };
    }
    if (rules.lineItems.start.includes(literal)) {
      return { valid: false, reason: `Start regex contains literal value "${literal}": ${rules.lineItems.start}` };
    }
  }

  // Check named groups
  const row = rules.lineItems.row;
  const requiredGroups = ["partNumber", "quantity", "unitPrice"];
  for (const group of requiredGroups) {
    if (!row.includes(`(?<${group}>`)) {
      return { valid: false, reason: `Row regex missing named group: ${group}` };
    }
  }

  // Check literal fraction
  const rowFrac = literalFraction(row);
  if (rowFrac > 0.4) {
    return { valid: false, reason: `Row regex is ${Math.round(rowFrac * 100)}% literal: ${row}` };
  }

  // Check extraction: does the template actually extract items?
  const result = applyTemplate(text, rules);

  if (result.items.length < extraction.items.length) {
    // Diagnose why extraction failed
    const startMatch = safeMatch(text, rules.lineItems.start, "i");
    let diag = `start=${startMatch ? "MATCHED" : "NO_MATCH"}`;
    if (startMatch && startMatch.index != null) {
      const afterStart = text.slice(startMatch.index + startMatch[0].length);
      const endMatch = safeMatch(afterStart, rules.lineItems.end, "i");
      const tableText = endMatch?.index != null ? afterStart.slice(0, endMatch.index) : afterStart;
      diag += ` end=${endMatch ? "MATCHED" : "NO_MATCH"} tableLen=${tableText.length}`;
      // Show first 200 chars of table region
      const preview = tableText.slice(0, 200).replace(/\n/g, "\\n").replace(/\t/g, "\\t");
      diag += ` tablePreview="${preview}"`;
    }
    console.warn(`[Template] extraction diagnostic: ${diag}`);
    console.warn(`[Template] patterns: start=/${rules.lineItems.start}/ end=/${rules.lineItems.end}/ row=/${rules.lineItems.row}/`);

    return {
      valid: false,
      reason: `Template extracted ${result.items.length} items, LLM extracted ${extraction.items.length} [${diag}]`,
    };
  }

  // Check part numbers match
  const templatePNs = new Set(result.items.map((i) => i.partNumber));
  const llmPNs = extraction.items.map((i) => i.partNumber).filter(Boolean);
  for (const pn of llmPNs) {
    if (!templatePNs.has(pn)) {
      return { valid: false, reason: `Template missing part number: ${pn}` };
    }
  }

  // Check prices match
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
