import { PDFParse } from "pdf-parse";
import type { DocumentResult, ExtractedItem, StepCallback, ExtractionRules } from "./template-types.js";
import { applyTemplate, distributeAndNormalize, safeMatch } from "./template-apply.js";
import { validateTemplate, findFieldFailures, type FieldFailure } from "./template-validate.js";
import { llmExtract, llmFillIn, llmGenerateTemplate, llmRepairRegex, isLlmConfigured } from "./template-llm.js";
import {
  loadAllTemplates,
  detectVendor,
  incrementSuccess,
  incrementFail,
  upsertTemplate,
} from "./vendor-detect.js";

export type { DocumentResult, ExtractedItem };
export { distributeAndNormalize } from "./template-apply.js";

// --- Part number patterns (shared with HTML parser) ---

const PART_PATTERNS: RegExp[] = [
  /\b(WP[A-Z]?\d{6,12})\b/i,
  /\b(AP\d{7,10})\b/i,
  /\b(PS\d{7,11})\b/i,
  /\b(DC\d{2}-\d{4,6}[A-Z]?)\b/i,
  /\b(WR\d{2}[A-Z]\d{4,6})\b/i,
  /\b(WB\d{2}[A-Z]\d{4,6})\b/i,
  /\b(WH\d{2}[A-Z]\d{4,6})\b/i,
  /\b(WE\d{2}[A-Z]\d{4,6})\b/i,
  /\b(DE\d{2}[A-Z]\d{4,6})\b/i,
  /\b(DD\d{2}-\d{5,8}[A-Z]?)\b/i,
  /\b(W\d{8,10})\b/i,
  /\b(EAP\d{6,10})\b/i,
  /\b(AH\d{6,10})\b/i,
  /\b(\d{6,8}[A-Z]{1,2})\b/,
];

const BRAND_PATTERN =
  /\b(whirlpool|kenmore|ge|samsung|lg|maytag|frigidaire|bosch|kitchenaid|amana|hotpoint|electrolux|haier|hisense)\b/i;

export function findPartNumbers(text: string): string[] {
  const matches: Array<{ pn: string; index: number }> = [];
  const seen = new Set<string>();
  for (const pattern of PART_PATTERNS) {
    const re = new RegExp(pattern, "gi");
    let m;
    while ((m = re.exec(text)) !== null) {
      const pn = m[1].toUpperCase();
      if (!seen.has(pn)) {
        seen.add(pn);
        matches.push({ pn, index: m.index });
      }
    }
  }
  return matches.sort((a, b) => a.index - b.index).map((m) => m.pn);
}

export function findBrand(text: string): string | null {
  const m = BRAND_PATTERN.exec(text);
  return m ? m[1].toLowerCase() : null;
}

const MAX_LLM_TEXT = 10_000;

export async function parseDocument(
  pdfBase64: string,
  onStep: StepCallback = () => {},
  abortSignal?: AbortSignal
): Promise<DocumentResult> {
  // Step 1: Extract text
  onStep("extracting_text", "Extracting text from PDF...");
  const buffer = Buffer.from(pdfBase64, "base64");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  await parser.destroy();

  const text = result.text.replace(/\f/g, "\n").trim();
  if (text.length < 20) {
    throw new Error("Document appears to be empty or image-only");
  }

  // Step 2: Detect vendor
  onStep("detecting_vendor", "Searching for vendor template...");
  const templates = await loadAllTemplates();
  const matched = detectVendor(text, templates);

  if (matched) {
    const tpl = matched.template;
    const isUnreliable =
      tpl.failCount > 3 && tpl.successCount < tpl.failCount;

    if (!isUnreliable) {
      onStep("vendor_matched", `Vendor matched: ${tpl.vendorName}`);
      onStep("applying_template", "Applying learned template...");

      const extracted = applyTemplate(text, tpl.extractionRules);

      if (extracted.items.length > 0) {
        // Fill in missing fields (totals + metadata) with a cheap nano call
        const hasShip = extracted.items.some((i) => (i.shipCost ?? 0) > 0);
        const hasTax = extracted.items.some((i) => (i.taxPrice ?? 0) > 0);
        const missingTotals = !hasShip || !hasTax;
        const missing: string[] = [];
        if (!hasShip) missing.push("shipping");
        if (!hasTax) missing.push("tax");
        if (!extracted.orderNumber) missing.push("order #");
        if (!extracted.orderDate) missing.push("date");
        if (!extracted.technicianName) missing.push("technician");
        if (!extracted.trackingNumber) missing.push("tracking");
        if (!extracted.deliveryCourier) missing.push("courier");

        if (missing.length > 0 && isLlmConfigured()) {
          onStep("filling_metadata", `LLM filling: ${missing.join(", ")}`);
          try {
            const fill = await llmFillIn(text, abortSignal);
            if (missingTotals) {
              const curTax = hasTax ? extracted.items.reduce((s, i) => s + (i.taxPrice ?? 0) * i.quantity, 0) : 0;
              const curShip = hasShip ? extracted.items.reduce((s, i) => s + (i.shipCost ?? 0) * i.quantity, 0) : 0;
              const tax = hasTax ? curTax : (fill.totalTax ?? 0);
              const shipping = hasShip ? curShip : (fill.totalShipping ?? 0);
              if (tax > 0 || shipping > 0) {
                distributeAndNormalize(extracted.items, shipping, tax);
              }
            }
            if (!extracted.orderNumber && fill.orderNumber) extracted.orderNumber = fill.orderNumber;
            if (!extracted.orderDate && fill.orderDate) extracted.orderDate = fill.orderDate;
            if (!extracted.technicianName && fill.technicianName) extracted.technicianName = fill.technicianName;
            if (!extracted.trackingNumber && fill.trackingNumber) extracted.trackingNumber = fill.trackingNumber;
            if (!extracted.deliveryCourier && fill.deliveryCourier) extracted.deliveryCourier = fill.deliveryCourier;

          } catch {
            // Non-critical -- items still extracted
          }
        }

        incrementSuccess(tpl.id).catch(() => {});

        // Spot-check: every 10th use, verify template output against nano
        if (isLlmConfigured() && (tpl.successCount + 1) % 10 === 0) {
          verifyTemplateInBackground(text, extracted, tpl.id);
        }

        onStep("done", `${extracted.items.length} item${extracted.items.length !== 1 ? "s" : ""} extracted`);
        return extracted;
      }

      onStep("template_failed", "Template extraction failed. Falling back to LLM...");
      // Only count failures from domain-matched templates (keyword matches are false-positive-prone)
      if (matched.confidence === "domain") {
        incrementFail(tpl.id).catch(() => {});
      }

      // Only allow regeneration if template is already unreliable AND match was high-confidence
      const canRegenerate =
        matched.confidence === "domain" &&
        tpl.failCount + 1 > 3 && tpl.successCount < tpl.failCount + 1;
      return llmPath(text, onStep, abortSignal, canRegenerate ? tpl.id : undefined);
    } else {
      onStep("template_failed", `Template for ${tpl.vendorName} is unreliable. Using LLM...`);
      return llmPath(text, onStep, abortSignal, tpl.id);
    }
  }

  onStep("no_template", "New vendor detected. Learning template via LLM...");
  return llmPath(text, onStep, abortSignal);
}

async function llmPath(
  text: string,
  onStep: StepCallback,
  abortSignal?: AbortSignal,
  existingTemplateId?: number
): Promise<DocumentResult> {
  if (!isLlmConfigured()) {
    throw new Error(
      "No extraction template for this vendor. Set OPENAI_API_KEY to enable automatic template learning."
    );
  }

  if (abortSignal?.aborted) throw new Error("Request cancelled");

  // Step 1: Fast extraction with nano
  onStep("llm_extracting", "Extracting data with gpt-5.4-nano...");

  const llmText = text.length > MAX_LLM_TEXT ? text.slice(0, MAX_LLM_TEXT) : text;
  const extraction = await llmExtract(llmText, abortSignal);

  const items: ExtractedItem[] = extraction.items.map((item) => ({
    partNumber: item.partNumber,
    partName: item.partName,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    shipCost: null,
    taxPrice: null,
    brand: item.brand,
  }));

  const tax = extraction.totalTax ?? 0;
  const shipping = extraction.totalShipping ?? 0;
  if ((tax > 0 || shipping > 0) && items.length > 0) {
    distributeAndNormalize(items, shipping, tax);
  }

  const docResult: DocumentResult = {
    vendor: extraction.vendor,
    orderNumber: extraction.orderNumber,
    orderDate: extraction.orderDate,
    technicianName: extraction.technicianName,
    trackingNumber: extraction.trackingNumber,
    deliveryCourier: extraction.deliveryCourier,
    items,
    rawText: text,
  };

  // Step 2: Generate template with mini (smarter model for regex)
  onStep("generating_template", "Generating reusable template with gpt-5.4-mini...");
  try {
    const templateRules = await llmGenerateTemplate(llmText, extraction, abortSignal);

    // Validate + repair loop: try up to 2 rounds
    let saved = false;
    for (let attempt = 0; attempt < 2 && !saved; attempt++) {
      onStep("validating_template", attempt === 0 ? "Validating generated template..." : "Re-validating after repair...");
      const validation = validateTemplate(text, templateRules, extraction);

      if (validation.valid) {
        // Check field/total patterns
        const failures = findFieldFailures(text, templateRules, extraction);
        if (failures.length > 0) {
          onStep("repairing_template", `Repairing ${failures.length} pattern${failures.length > 1 ? "s" : ""}...`);
          await applyRepairs(text, templateRules, failures, abortSignal);
        }

        // Strip bad totals
        const subtotal = extraction.items.reduce((s, i) => s + (i.unitPrice ?? 0) * i.quantity, 0);
        templateRules.totals = templateRules.totals.filter((t) => {
          const m = safeMatch(text, t.regex, "s");
          const val = m?.[1] ? parseFloat(m[1]) : 0;
          const llmVal = t.name === "tax" ? (extraction.totalTax ?? 0) : (extraction.totalShipping ?? 0);
          return !(val > subtotal || (llmVal > 0 && Math.abs(val - llmVal) > 1));
        });

        await upsertTemplate(templateRules, existingTemplateId);
        onStep("template_stored", "Template learned and stored. Future invoices from this vendor will be instant.");
        saved = true;
      } else if (attempt === 0) {
        // First failure -- attempt repair of whatever broke (including row regex)
        console.warn("Template validation failed:", validation.reason);
        onStep("repairing_template", "Template failed validation. Attempting repair...");

        // Build repair context for the specific failure
        const itemFailure = validation.reason?.includes("items");
        if (itemFailure && extraction.items.length > 0) {
          // Row regex doesn't work -- send example item line for repair
          const firstItem = extraction.items[0];
          const itemContext = text.split("\n").find((line) =>
            line.includes(firstItem.partNumber) || (firstItem.partName && line.includes(firstItem.partName.split(" ")[0]))
          ) ?? "";
          const repairs = await llmRepairRegex([{
            name: "row",
            type: "field" as const,
            expected: `partNumber=${firstItem.partNumber}, description=${firstItem.partName}, quantity=${firstItem.quantity}, unitPrice=${firstItem.unitPrice}`,
            got: "(0 items matched)",
            context: `Start marker regex: ${templateRules.lineItems.start}\nEnd marker regex: ${templateRules.lineItems.end}\nCurrent row regex: ${templateRules.lineItems.row}\n\nExample item line from text:\n${itemContext}\n\nSurrounding text:\n${text.slice(Math.max(0, text.indexOf(itemContext) - 200), text.indexOf(itemContext) + itemContext.length + 200)}`,
          }], abortSignal);

          for (const repair of repairs) {
            if (repair.name === "row") {
              templateRules.lineItems.row = repair.regex;
            }
          }
        }
        // Loop will re-validate on next iteration
      } else {
        console.warn("Template repair failed after retry:", validation.reason);
        onStep("template_validation_failed", `Template validation failed: ${validation.reason}`);
      }
    }
  } catch (err) {
    console.warn("Template generation failed:", err);
    onStep("template_validation_failed", "Template generation failed. Extraction still succeeded.");
  }

  onStep("done", `${docResult.items.length} item${docResult.items.length !== 1 ? "s" : ""} extracted`);
  return docResult;
}

async function applyRepairs(
  text: string,
  rules: ExtractionRules,
  failures: FieldFailure[],
  abortSignal?: AbortSignal
): Promise<void> {
  try {
    const repairs = await llmRepairRegex(failures, abortSignal);
    for (const repair of repairs) {
      const m = safeMatch(text, repair.regex, "s");
      if (!m?.[repair.group]) continue;

      if (repair.type === "field") {
        const idx = rules.fields.findIndex((f) => f.name === repair.name);
        const rule = { name: repair.name, regex: repair.regex, group: repair.group };
        if (idx >= 0) rules.fields[idx] = rule;
        else rules.fields.push(rule);
      } else if (repair.type === "total") {
        const idx = rules.totals.findIndex((t) => t.name === repair.name);
        const rule = { name: repair.name, regex: repair.regex };
        if (idx >= 0) rules.totals[idx] = rule;
        else rules.totals.push(rule);
      }
    }
  } catch {
    console.warn("Template repair failed");
  }
}

/**
 * Fire-and-forget: run nano extraction and compare against template result.
 * If items diverge (different count or missing part numbers), increment failCount.
 * This catches silent template degradation from vendor format changes.
 */
function verifyTemplateInBackground(
  text: string,
  templateResult: DocumentResult,
  templateId: number
): void {
  const llmText = text.length > MAX_LLM_TEXT ? text.slice(0, MAX_LLM_TEXT) : text;
  llmExtract(llmText).then((nano) => {
    const tplPNs = new Set(templateResult.items.map((i) => i.partNumber));
    const nanoPNs = new Set(nano.items.map((i) => i.partNumber).filter(Boolean));

    // Check: does nano find items the template missed?
    let mismatched = false;
    if (nano.items.length > templateResult.items.length) mismatched = true;
    for (const pn of nanoPNs) {
      if (!tplPNs.has(pn)) { mismatched = true; break; }
    }

    if (mismatched) {
      console.warn(`Template ${templateId} spot-check FAILED: template=${templateResult.items.length} items, nano=${nano.items.length} items`);
      incrementFail(templateId).catch(() => {});
    }
  }).catch(() => {
    // Spot-check failure is non-critical
  });
}

