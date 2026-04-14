import RE2 from "re2";
import type { ExtractionRules } from "./template-types.js";
import { applyTemplate } from "./template-apply.js";
import type { LlmExtraction } from "./template-llm.js";
import { parseSubtotal } from "./validation-stack.js";

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export type ConfidenceTier = 1 | 2 | 3;

/**
 * Determine confidence tier based on available ground truth.
 * Tier 1: nano passes math check (strongest)
 * Tier 2: part number agreement without math (moderate)
 * Tier 3: neither available (no confidence)
 */
export function determineConfidenceTier(
  nanoExtraction: LlmExtraction,
  rawText: string,
  textPartNumbers: string[]
): ConfidenceTier {
  // Tier 1: nano passes math check
  const subtotal = parseSubtotal(rawText);
  if (subtotal != null) {
    const nanoSum = nanoExtraction.items.reduce(
      (sum, i) => sum + (i.unitPrice ?? 0) * i.quantity,
      0
    );
    if (Math.abs(Math.round(nanoSum * 100) / 100 - subtotal) < 0.01) {
      return 1;
    }
  }

  // Tier 2: part number agreement without math
  if (textPartNumbers.length > 0) {
    const nanoPNs = new Set(nanoExtraction.items.map((i) => i.partNumber.toUpperCase()));
    const overlap = textPartNumbers.filter((pn) => nanoPNs.has(pn));
    if (overlap.length / textPartNumbers.length >= 0.8) {
      return 2;
    }
  }

  return 3;
}

/**
 * Validate a generated/repaired template against nano's extraction.
 * Tier 1: math gate + nano cross-check (part numbers + prices)
 * Tier 2: nano cross-check only (part numbers + quantities, NO prices)
 * Tier 3: never reaches here (blocked by confidence gate)
 */
export function validateTemplate(
  rawText: string,
  rules: ExtractionRules,
  nanoExtraction: LlmExtraction,
  tier: ConfidenceTier
): ValidationResult {
  // RE2 compatibility check
  const patterns = [rules.lineItems.start, rules.lineItems.end, rules.lineItems.row];
  for (const pattern of patterns) {
    try {
      new RE2(pattern);
    } catch (err) {
      return { valid: false, reason: `RE2 incompatible pattern: ${pattern} -- ${err}` };
    }
  }

  // Check named groups exist in row regex
  const row = rules.lineItems.row;
  for (const group of ["partNumber", "quantity", "unitPrice"]) {
    if (!row.includes(`(?<${group}>`)) {
      return { valid: false, reason: `Row regex missing named group: ${group}` };
    }
  }

  // Apply template to raw text
  const result = applyTemplate(rawText, rules);
  if (result.items.length === 0) {
    return { valid: false, reason: "Template extracted 0 items" };
  }

  // Part number gate (both tiers)
  const templatePNs = new Set(result.items.map((i) => i.partNumber));
  const nanoPNs = nanoExtraction.items.map((i) => i.partNumber).filter(Boolean);
  for (const pn of nanoPNs) {
    if (!templatePNs.has(pn)) {
      return { valid: false, reason: `Template missing part number: ${pn}` };
    }
  }

  // Quantity gate (both tiers)
  for (const nanoItem of nanoExtraction.items) {
    const tplItem = result.items.find((i) => i.partNumber === nanoItem.partNumber);
    if (tplItem && tplItem.quantity !== nanoItem.quantity) {
      return {
        valid: false,
        reason: `Quantity mismatch for ${nanoItem.partNumber}: template=${tplItem.quantity}, nano=${nanoItem.quantity}`,
      };
    }
  }

  // Description quality check (warning only -- sanitizer handles cleanup)
  for (const nanoItem of nanoExtraction.items) {
    if (!nanoItem.partName) continue;
    const tplItem = result.items.find((i) => i.partNumber === nanoItem.partNumber);
    if (!tplItem || !tplItem.partName) continue;
    const nanoName = nanoItem.partName.trim();
    const tplName = tplItem.partName.trim();
    if (nanoName.length > 0 && tplName.length > nanoName.length * 1.3) {
      console.warn(`[Template] description bloat for ${nanoItem.partNumber}: template="${tplName}" (${tplName.length} chars), nano="${nanoName}" (${nanoName.length} chars)`);
    }
  }

  if (tier === 1) {
    // Price gate (tier 1 only)
    for (const nanoItem of nanoExtraction.items) {
      if (nanoItem.unitPrice == null) continue;
      const tplItem = result.items.find((i) => i.partNumber === nanoItem.partNumber);
      if (!tplItem || tplItem.unitPrice == null) continue;
      if (Math.abs(tplItem.unitPrice - nanoItem.unitPrice) > 0.01) {
        return {
          valid: false,
          reason: `Price mismatch for ${nanoItem.partNumber}: template=${tplItem.unitPrice}, nano=${nanoItem.unitPrice}`,
        };
      }
    }

    // Math gate (tier 1 only)
    const subtotal = parseSubtotal(rawText);
    if (subtotal != null) {
      const computed = Math.round(
        result.items.reduce((sum, i) => sum + (i.unitPrice ?? 0) * i.quantity, 0) * 100
      ) / 100;
      if (Math.abs(computed - subtotal) > 0.01) {
        return {
          valid: false,
          reason: `Math mismatch: template sum=${computed}, subtotal=${subtotal}`,
        };
      }
    }
  }

  return { valid: true };
}
