import { findPartNumbers } from "./document-parser.js";

export type DocType = "credit" | "quote" | "invoice";

export interface ValidationResult {
  scored: boolean;
  pass: boolean | null; // null = unverified
  reason?: string;
}

interface ExtractedItemForValidation {
  partNumber: string;
  quantity: number;
  unitPrice: number | null;
}

const DISCOUNT_PART_PATTERN = /^(DISCOUNT|COUPON|PROMO)/i;

export function detectDocType(rawText: string): DocType {
  const lower = rawText.toLowerCase();

  // Check for negative total: look for a total/grand total line with a negative number
  const negativeTotalPattern = /(?:grand\s+total|total)[^\n]*-\s*\$?\s*[\d,.]+/i;
  const hasNegativeTotal = negativeTotalPattern.test(rawText);

  if (
    lower.includes("credit memo") ||
    lower.includes("credit note") ||
    lower.includes("return authorization") ||
    hasNegativeTotal
  ) {
    return "credit";
  }

  if (
    lower.includes("quote") ||
    lower.includes("estimate") ||
    lower.includes("quotation") ||
    lower.includes("not an invoice")
  ) {
    return "quote";
  }

  return "invoice";
}

export function parseSubtotal(rawText: string): number | null {
  const lines = rawText.split("\n");
  for (const line of lines) {
    if (/sub\s*total/i.test(line)) {
      // Extract dollar amount from the line - handle negative values
      const match = line.match(/-?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/);
      if (match) {
        const raw = match[0].replace(/[\$\s,]/g, "");
        const value = parseFloat(raw);
        if (!isNaN(value)) {
          return value;
        }
      }
    }
  }
  return null;
}

export function validateExtraction(
  items: ExtractedItemForValidation[],
  rawText: string,
  docType: DocType
): ValidationResult {
  // Check 1: Row sanity (not scored)
  for (const item of items) {
    if (!item.partNumber || item.partNumber.trim().length === 0) {
      return { scored: false, pass: null, reason: "Row sanity failed: empty part number" };
    }
    if (item.quantity <= 0) {
      return { scored: false, pass: null, reason: `Row sanity failed: quantity ${item.quantity} <= 0` };
    }
    if (docType !== "credit" && item.unitPrice != null && item.unitPrice < 0) {
      return { scored: false, pass: null, reason: `Row sanity failed: negative price on non-credit doc` };
    }
  }

  // Check 2: Part number coverage
  const textPartNumbers = findPartNumbers(rawText);
  const templatePartNumbers = items.map((i) => i.partNumber.toUpperCase());

  let coveragePass: boolean | null = null; // null = indeterminate

  if (textPartNumbers.length > 0) {
    // Filter out discount lines from the denominator
    const nonDiscountTextParts = textPartNumbers.filter(
      (pn) => !DISCOUNT_PART_PATTERN.test(pn)
    );

    if (nonDiscountTextParts.length > 0) {
      const templateSet = new Set(templatePartNumbers);
      const overlap = nonDiscountTextParts.filter((pn) => templateSet.has(pn)).length;
      const coverage = overlap / nonDiscountTextParts.length;
      coveragePass = coverage >= 0.8;
    } else {
      // All text parts are discount lines - indeterminate
      coveragePass = null;
    }
  }
  // else: findPartNumbers returned empty -> indeterminate (coveragePass stays null)

  if (coveragePass === false) {
    return { scored: true, pass: false, reason: "Part number coverage below 80%" };
  }

  // Check 3: Math check
  const subtotal = parseSubtotal(rawText);
  let mathPass: boolean | null = null; // null = indeterminate

  if (subtotal !== null) {
    const computed = items.reduce((sum, item) => {
      const price = item.unitPrice ?? 0;
      return sum + price * item.quantity;
    }, 0);

    const effectiveComputed = docType === "credit" ? Math.abs(computed) : computed;
    const effectiveSubtotal = docType === "credit" ? Math.abs(subtotal) : subtotal;

    mathPass = Math.abs(effectiveComputed - effectiveSubtotal) < 0.01;
  }

  if (mathPass === false) {
    return { scored: true, pass: false, reason: "Math check failed: computed total does not match subtotal" };
  }

  // Combined scoring
  // Coverage fails -> already returned above
  // Math fails -> already returned above
  // Math passes + coverage passes -> pass: true
  // Math passes + coverage indeterminate -> pass: true
  // Math indeterminate + coverage passes -> pass: null (unverified)
  // Both indeterminate -> pass: null (unverified)

  if (mathPass === true) {
    return { scored: true, pass: true };
  }

  // mathPass is null (indeterminate), coveragePass is true or null
  if (coveragePass === true) {
    return { scored: true, pass: null, reason: "Math indeterminate, coverage passed (unverified)" };
  }

  // Both indeterminate
  return { scored: true, pass: null, reason: "Both math and coverage indeterminate (unverified)" };
}
