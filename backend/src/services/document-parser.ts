import { PDFParse } from "pdf-parse";
import type { DocumentResult, ExtractedItem, StepCallback } from "./template-types.js";
import { applyTemplate, distributeAndNormalize, safeMatch } from "./template-apply.js";
import { validateTemplate } from "./template-validate.js";
import { llmExtract, llmGenerateTemplate, isLlmConfigured } from "./template-llm.js";
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
        incrementSuccess(tpl.id).catch(() => {});
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

    onStep("validating_template", "Validating generated template...");
    const validation = validateTemplate(text, templateRules, extraction);

    if (validation.valid) {
      await upsertTemplate(templateRules, existingTemplateId);
      onStep(
        "template_stored",
        "Template learned and stored. Future invoices from this vendor will be instant."
      );
    } else {
      console.warn("Template validation failed:", validation.reason);
      onStep(
        "template_validation_failed",
        `Template validation failed: ${validation.reason}`
      );
    }
  } catch (err) {
    console.warn("Template generation failed:", err);
    onStep("template_validation_failed", "Template generation failed. Extraction still succeeded.");
  }

  onStep("done", `${docResult.items.length} item${docResult.items.length !== 1 ? "s" : ""} extracted`);
  return docResult;
}
