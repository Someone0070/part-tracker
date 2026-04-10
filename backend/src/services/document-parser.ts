import { PDFParse } from "pdf-parse";
import type { DocumentResult, ExtractedItem, StepCallback, ExtractionRules } from "./template-types.js";
import { applyTemplate, distributeAndNormalize } from "./template-apply.js";
import { validateTemplate } from "./template-validate.js";
import { llmExtract, llmFillIn, llmGenerateTemplate, llmRepairRowRegex, isLlmConfigured, isEscalationConfigured, ESCALATION_MODEL } from "./template-llm.js";
import { checkExtraction } from "./extraction-sanity.js";
import {
  loadAllTemplates,
  detectVendor,
  incrementSuccess,
  incrementFail,
  upsertTemplate,
  recordFailedAttempt,
  isInCooldown,
  hasUsableRules,
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

/**
 * Fix tracking numbers that got split across PDF lines.
 */
function fixSplitTracking(result: DocumentResult): void {
  if (!result.trackingNumber || !result.rawText) return;
  const tracking = result.trackingNumber;
  if (!/^\d{8,}$/.test(tracking)) return;

  const lines = result.rawText.split("\n");
  const idx = lines.findIndex((l) => l.trim() === tracking || l.includes(tracking));
  if (idx < 0 || idx + 1 >= lines.length) return;

  const nextLine = lines[idx + 1].trim();
  if (/^\d{1,3}$/.test(nextLine)) {
    result.trackingNumber = tracking + nextLine;
  }
}

/**
 * Fill in metadata + totals from nano, then distribute tax/shipping to items.
 */
async function fillMetadata(
  result: DocumentResult,
  text: string,
  onStep: StepCallback,
  abortSignal?: AbortSignal
): Promise<void> {
  if (!isLlmConfigured()) return;

  onStep("filling_metadata", "Filling metadata with gpt-5.4-nano...");
  try {
    const fill = await llmFillIn(text, abortSignal);

    result.orderNumber = fill.orderNumber;
    result.orderDate = fill.orderDate;
    result.technicianName = fill.technicianName;
    result.trackingNumber = fill.trackingNumber;
    result.deliveryCourier = fill.deliveryCourier;

    const tax = fill.totalTax ?? 0;
    const shipping = fill.totalShipping ?? 0;
    if ((tax > 0 || shipping > 0) && result.items.length > 0) {
      distributeAndNormalize(result.items, shipping, tax);
    }
  } catch {
    // Non-critical -- items still extracted
  }
}

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
    const usable = hasUsableRules(tpl);
    const isUnreliable = tpl.failCount > 3 && tpl.successCount < tpl.failCount;

    if (usable && !isUnreliable) {
      onStep("vendor_matched", `Vendor matched: ${tpl.vendorName}`);
      onStep("applying_template", "Applying learned template...");

      const extracted = applyTemplate(text, tpl.extractionRules);

      if (extracted.items.length > 0) {
        // Sanity check items
        const sanity = checkExtraction(extracted);
        if (!sanity.pass) {
          console.warn(`Template sanity FAILED (score=${sanity.score}):`, sanity.failures);
          onStep("sanity_failed", `Template data looks wrong. Falling back to LLM...`);
          incrementFail(tpl.id).catch(() => {});
          return llmExtractOnly(text, onStep, abortSignal);
        }

        // Items good -- fill metadata from nano
        await fillMetadata(extracted, text, onStep, abortSignal);
        fixSplitTracking(extracted);

        incrementSuccess(tpl.id).catch(() => {});

        if (isLlmConfigured() && (tpl.successCount + 1) % 10 === 0) {
          verifyTemplateInBackground(text, extracted, tpl.id);
        }

        onStep("done", `${extracted.items.length} item${extracted.items.length !== 1 ? "s" : ""} extracted`);
        return extracted;
      }

      onStep("template_failed", "Template extraction failed. Falling back to LLM...");
      if (matched.confidence === "domain") {
        incrementFail(tpl.id).catch(() => {});
      }

      const canRegenerate =
        matched.confidence === "domain" &&
        tpl.failCount + 1 > 3 && tpl.successCount < tpl.failCount + 1;
      return llmPath(text, onStep, abortSignal, canRegenerate ? tpl.id : undefined);
    }

    if (!usable) {
      if (isInCooldown(tpl)) {
        const daysLeft = Math.ceil(
          (7 * 24 * 60 * 60 * 1000 - (Date.now() - tpl.lastGenerationAttempt!.getTime())) / (24 * 60 * 60 * 1000)
        );
        onStep("template_cooldown", `Template generation for ${tpl.vendorName} failed recently. Retrying in ${daysLeft}d.`);
        return llmExtractOnly(text, onStep, abortSignal);
      }
      onStep("template_retry", `Retrying template generation for ${tpl.vendorName}...`);
      return llmPath(text, onStep, abortSignal, tpl.id);
    }

    onStep("template_failed", `Template for ${tpl.vendorName} is unreliable. Using LLM...`);
    return llmPath(text, onStep, abortSignal, tpl.id);
  }

  onStep("no_template", "New vendor detected. Learning template via LLM...");
  return llmPath(text, onStep, abortSignal);
}

/**
 * LLM extraction only -- no template generation.
 */
async function llmExtractOnly(
  text: string,
  onStep: StepCallback,
  abortSignal?: AbortSignal
): Promise<DocumentResult> {
  if (!isLlmConfigured()) {
    throw new Error("No extraction template for this vendor. Set OPENAI_API_KEY to enable automatic template learning.");
  }
  if (abortSignal?.aborted) throw new Error("Request cancelled");

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
  fixSplitTracking(docResult);

  onStep("done", `${items.length} item${items.length !== 1 ? "s" : ""} extracted`);
  return docResult;
}

async function llmPath(
  text: string,
  onStep: StepCallback,
  abortSignal?: AbortSignal,
  existingTemplateId?: number
): Promise<DocumentResult> {
  if (!isLlmConfigured()) {
    throw new Error("No extraction template for this vendor. Set OPENAI_API_KEY to enable automatic template learning.");
  }
  if (abortSignal?.aborted) throw new Error("Request cancelled");

  // Step 1: Extract everything with nano
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
  fixSplitTracking(docResult);

  onStep("done", `${docResult.items.length} item${docResult.items.length !== 1 ? "s" : ""} extracted`);

  // Template generation runs in background -- don't block the response
  learnTemplateInBackground(text, llmText, extraction, existingTemplateId, columnHintFor(text, extraction));

  return docResult;
}

function columnHintFor(text: string, extraction: { items: Array<{ partNumber: string }> }): string {
  if (extraction.items.length === 0) return "";
  const firstItem = extraction.items[0];
  const itemLine = text.split("\n").find((line) => line.includes(firstItem.partNumber));
  if (!itemLine || !itemLine.includes("\t")) return "";
  const cols = itemLine.split("\t");
  const pnIdx = cols.findIndex((c) => c.trim() === firstItem.partNumber);
  if (pnIdx < 0) return "";
  return `The item line has ${cols.length} tab-separated columns. Part number "${firstItem.partNumber}" is in column ${pnIdx + 1}.\nColumns: ${cols.map((c, i) => `[${i + 1}]="${c.trim()}"`).join("  ")}`;
}

function learnTemplateInBackground(
  text: string,
  llmText: string,
  extraction: import("./template-llm.js").LlmExtraction,
  existingTemplateId: number | undefined,
  columnHint: string
): void {
  if (columnHint) {
    console.log(`[Template] column hint:\n${columnHint}`);
  } else {
    console.log(`[Template] no column hint generated`);
  }

  (async () => {
    try {
      const templateRules = await llmGenerateTemplate(llmText, extraction, undefined, undefined, columnHint);

      let saved = false;
      for (let attempt = 0; attempt < 2 && !saved; attempt++) {
        const validation = validateTemplate(text, templateRules, extraction);

        if (validation.valid) {
          await upsertTemplate(templateRules, existingTemplateId);
          console.log(`[Template] learned for ${templateRules.vendorName}`);
          saved = true;
        } else if (attempt === 0) {
          console.warn("[Template] validation failed:", validation.reason);

          if (extraction.items.length > 0) {
            const firstItem = extraction.items[0];
            const itemContext = text.split("\n").find((line) => line.includes(firstItem.partNumber)) ?? "";

            let annotation = "";
            if (itemContext.includes("\t")) {
              const cols = itemContext.split("\t");
              const pnIdx = cols.findIndex((c) => c.trim() === firstItem.partNumber);
              if (pnIdx >= 0) {
                annotation = `\nColumn layout: ${cols.map((c, i) => `[${i + 1}]="${c.trim()}"`).join("  ")}`;
              }
            }

            const fixedRow = await llmRepairRowRegex({
              expected: `partNumber=${firstItem.partNumber}, description=${firstItem.partName}, quantity=${firstItem.quantity}, unitPrice=${firstItem.unitPrice}`,
              got: validation.reason ?? "0 items matched",
              context: `Start: ${templateRules.lineItems.start}\nEnd: ${templateRules.lineItems.end}\nRow: ${templateRules.lineItems.row}\n\nExample line: ${itemContext}${annotation}`,
            });

            if (fixedRow) templateRules.lineItems.row = fixedRow;
          }
        } else {
          console.warn("[Template] repair failed:", validation.reason);
        }
      }

      // Escalation: if mini failed, try Gemini
      if (!saved && isEscalationConfigured()) {
        console.log("[Template] escalating to Gemini 2.5 Flash...");
        try {
          const escalatedRules = await llmGenerateTemplate(llmText, extraction, undefined, ESCALATION_MODEL, columnHint);
          const escalatedValidation = validateTemplate(text, escalatedRules, extraction);
          if (escalatedValidation.valid) {
            await upsertTemplate(escalatedRules, existingTemplateId);
            console.log(`[Template] learned via Gemini for ${escalatedRules.vendorName}`);
            saved = true;
          } else {
            console.warn("[Template] Gemini also failed:", escalatedValidation.reason);
          }
        } catch (err) {
          console.warn("[Template] Gemini escalation error:", err);
        }
      }

      if (!saved) {
        recordFailedAttempt(extraction.vendor, templateRules.vendorSignals).catch(() => {});
      }
    } catch (err) {
      console.warn("[Template] background generation failed:", err);
      recordFailedAttempt(extraction.vendor, { domains: [], keywords: [extraction.vendor.toLowerCase()] }).catch(() => {});
    }
  })();
}

function verifyTemplateInBackground(
  text: string,
  templateResult: DocumentResult,
  templateId: number
): void {
  const llmText = text.length > MAX_LLM_TEXT ? text.slice(0, MAX_LLM_TEXT) : text;
  llmExtract(llmText).then((llm) => {
    const tplPNs = new Set(templateResult.items.map((i) => i.partNumber));
    const llmPNs = new Set(llm.items.map((i) => i.partNumber).filter(Boolean));

    let mismatched = false;
    if (llm.items.length > templateResult.items.length) mismatched = true;
    for (const pn of llmPNs) {
      if (!tplPNs.has(pn)) { mismatched = true; break; }
    }

    if (mismatched) {
      console.warn(`Template ${templateId} spot-check FAILED: template=${templateResult.items.length} items, llm=${llm.items.length} items`);
      incrementFail(templateId).catch(() => {});
    }
  }).catch(() => {});
}
