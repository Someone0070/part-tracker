import RE2 from "re2";
import type { ExtractionRules } from "./template-types.js";
import { applyTemplate } from "./template-apply.js";
import type { LlmExtraction } from "./template-llm.js";
import { parseSubtotal } from "./validation-stack.js";

/** Tokenize a description for overlap comparison: lowercase, strip punctuation, split on whitespace */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

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

  // Description gate (both tiers) -- reject templates that overcapture into partName
  for (const nanoItem of nanoExtraction.items) {
    if (!nanoItem.partName || nanoItem.partName.trim().length === 0) continue;
    const tplItem = result.items.find((i) => i.partNumber === nanoItem.partNumber);
    if (!tplItem || !tplItem.partName) continue;
    const nanoTokens = tokenize(nanoItem.partName);
    const tplTokens = tokenize(tplItem.partName);
    if (nanoTokens.length === 0) continue;
    // Token overlap: at least 80% of nano's tokens must appear in template's tokens
    const tplTokenSet = new Set(tplTokens);
    const overlap = nanoTokens.filter((t) => tplTokenSet.has(t)).length;
    if (overlap / nanoTokens.length < 0.8) {
      return {
        valid: false,
        reason: `Description mismatch for ${nanoItem.partNumber}: template="${tplItem.partName}", nano="${nanoItem.partName}" (${overlap}/${nanoTokens.length} token overlap)`,
      };
    }
    // Template shouldn't capture significantly more than nano (status columns, etc.)
    const nanoLen = nanoItem.partName.trim().length;
    const tplLen = tplItem.partName.trim().length;
    if (nanoLen > 3 && tplLen > nanoLen * 1.3) {
      return {
        valid: false,
        reason: `Description overcapture for ${nanoItem.partNumber}: template="${tplItem.partName}" (${tplLen} chars), nano="${nanoItem.partName}" (${nanoLen} chars)`,
      };
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
