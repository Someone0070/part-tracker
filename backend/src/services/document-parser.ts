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

const ZAI_OCR_URL = "https://api.z.ai/api/paas/v4/layout_parsing";

/**
 * Detect if pdf-parse produced poor quality text that would confuse LLM extraction.
 * Returns a reason string if quality is poor, null if OK.
 */
function textQualityPoor(text: string): string | null {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  // 1. Orphan number blocks: 3+ consecutive lines that are just bare numbers
  //    (labels separated from their values, e.g. Encompass summary)
  let consecutiveNums = 0;
  for (const line of lines) {
    if (/^\$?\d[\d,.]*$/.test(line)) {
      consecutiveNums++;
      if (consecutiveNums >= 3) return "orphan-numbers";
    } else {
      consecutiveNums = 0;
    }
  }

  // 2. Fragment soup: >40% of lines are very short (1-3 chars)
  //    Signals fragmented column cells extracted one per line
  const fragments = lines.filter((l) => l.length <= 3).length;
  if (lines.length >= 10 && fragments / lines.length > 0.4) return "fragment-soup";

  // 3. Label dump: many label-like lines ("Foo:" or "Foo Bar:") without adjacent values
  //    5+ consecutive label-only lines = values are elsewhere
  let consecutiveLabels = 0;
  for (const line of lines) {
    if (/^[A-Za-z][A-Za-z &\/\-#.]+:?\s*$/.test(line) && line.length < 40) {
      consecutiveLabels++;
      if (consecutiveLabels >= 5) return "label-dump";
    } else {
      consecutiveLabels = 0;
    }
  }

  // 4. Near-duplicate blocks: same 50+ char substring appears 2+ times
  //    pdf-parse sometimes extracts overlaid text twice
  if (text.length > 200) {
    const half = Math.floor(text.length / 2);
    const firstHalf = text.slice(0, half);
    const secondHalf = text.slice(half);
    // Check if a significant chunk (50+ chars) from first half repeats in second half
    const sample = firstHalf.slice(0, 100);
    if (sample.length >= 50 && secondHalf.includes(sample)) return "duplicate-text";
  }

  return null;
}

/**
 * Re-extract text from PDF using z.ai GLM OCR (layout_parsing).
 * Returns cleaner text with proper label-value associations.
 */
async function ocrExtractText(pdfBase64: string, abortSignal?: AbortSignal): Promise<string | null> {
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey) return null;

  try {
    const dataUri = `data:application/pdf;base64,${pdfBase64}`;
    const res = await fetch(ZAI_OCR_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: "glm-ocr", file: dataUri }),
      signal: abortSignal,
    });

    if (!res.ok) {
      console.warn(`[OCR] z.ai returned ${res.status}`);
      return null;
    }

    const data = (await res.json()) as {
      md_results?: string;
      layout_details?: Array<Array<{ content?: string; label?: string }>> | Array<{ content?: string; label?: string }>;
    };

    // layout_details is nested: pages -> elements. Flatten to get all text.
    let detailsText = "";
    if (data.layout_details && Array.isArray(data.layout_details)) {
      const flat = data.layout_details.flat();
      detailsText = flat.map((d: { content?: string }) => d.content ?? "").join("\n");
    }

    // Prefer md_results (markdown), fall back to layout_details (plain text from regions)
    const rawOcr = data.md_results || detailsText || "";

    // Log what we got for debugging
    console.log(`[OCR] response: md_results=${data.md_results?.length ?? 0} chars, layout_details=${detailsText.length} chars`);
    if (detailsText.length > rawOcr.length) {
      console.log(`[OCR] layout_details has MORE content than md_results, using it`);
    }

    // Use whichever is more complete
    const bestText = detailsText.length > rawOcr.length ? detailsText : rawOcr;
    if (bestText.length < 20) return null;

    // Strip HTML tags and markdown artifacts -- nano can't parse markup
    const cleaned = bestText
      .replace(/<[^>]+>/g, " ")       // HTML tags → space
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/^#+\s*/gm, "")        // markdown headings
      .replace(/\[.*?\]\(.*?\)/g, "") // markdown links
      .replace(/[ \t]{2,}/g, " ")     // collapse horizontal whitespace (preserve newlines)
      .trim();

    return cleaned.length < 20 ? null : cleaned;
  } catch (err) {
    console.warn("[OCR] fallback failed:", err);
    return null;
  }
}

// --- Layout type detection ---

export type LayoutType = "tab-delimited" | "n-of" | "space-aligned" | "labeled";

export function detectLayoutType(text: string): LayoutType {
  const lines = text.split("\n");

  // Type A: Tab-delimited (4+ tab-separated columns on multiple lines)
  const tabLines = lines.filter((l) => l.split("\t").length >= 4);
  if (tabLines.length >= 2) return "tab-delimited";

  // Type B: Amazon "N of:" format
  if (/\d+\s+of:/i.test(text)) return "n-of";

  // Type C: Space-aligned columns (header row + data rows aligned by spaces)
  // eBay variant: items may wrap to 2 lines with tab before price on line 2
  const headerPatterns = [
    /quantity\s{2,}item\s*name/i,
    /item\s*#?\s{2,}description/i,
    /part\s*(?:number|#)\s{2,}/i,
    /qty\s{2,}.*price/i,
  ];
  if (headerPatterns.some((p) => p.test(text))) return "space-aligned";

  // Type D: Labeled sections (Order Number:, Invoice Date:, etc.)
  const labelCount = (text.match(/(?:order|invoice|part)\s*(?:number|#|date|total)\s*:/gi) || []).length;
  if (labelCount >= 2) return "labeled";

  // Default to labeled (most generic)
  return "labeled";
}

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
 * Try to recover tax/shipping from raw text when the LLM returns 0.
 * Scans for known summary labels near dollar amounts in the text.
 */
function recoverTotals(
  text: string,
  llmTax: number,
  llmShipping: number
): { tax: number; shipping: number } {
  let tax = llmTax;
  let shipping = llmShipping;

  // Only attempt recovery if one or both are missing
  if (tax > 0 && shipping > 0) return { tax, shipping };

  // Strategy 1: look for "label: $amount" or "label $amount" on same line
  const labelPatterns: Array<{ label: RegExp; field: "tax" | "shipping" }> = [
    { label: /\btax(?:\s+amount)?\s*[:=]?\s*\$?([\d,]+\.?\d*)/i, field: "tax" },
    { label: /\bship(?:ping)?(?:\s*(?:&|and)\s*handling)?\s*(?:charge)?\s*[:=]?\s*\$?([\d,]+\.?\d*)/i, field: "shipping" },
  ];

  for (const { label, field } of labelPatterns) {
    const m = label.exec(text);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ""));
      if (!isNaN(val) && val > 0) {
        if (field === "tax" && tax === 0) tax = val;
        if (field === "shipping" && shipping === 0) shipping = val;
      }
    }
  }

  // If Strategy 1 found new values, log and return
  if (tax !== llmTax || shipping !== llmShipping) {
    console.log(`[Recovery] totals recovered from text: tax=${llmTax}->${tax}, shipping=${llmShipping}->${shipping}`);
    if (tax > 0 && shipping > 0) return { tax, shipping };
  }

  // Strategy 2: math-based -- find total and subtotal in the text, compute gap
  // If gap > 0, look for orphan numbers that could be tax/shipping
  const lines = text.split("\n").map((l) => l.trim());

  // Find total and subtotal from labeled lines ("217.64    Sub Total" or "Total Amount    176.55")
  let docTotal: number | null = null;
  let docSubtotal: number | null = null;
  for (const line of lines) {
    const lower = line.toLowerCase();
    const nums = line.match(/\d[\d,]*\.\d{2}/g)?.map((n) => parseFloat(n.replace(/,/g, "")));
    if (!nums || nums.length === 0) continue;
    const val = nums[0];
    if (/\bsub\s*total\b/i.test(lower)) docSubtotal = val;
    else if (/\btotal\s*(amount)?\b/i.test(lower) && !/sub/i.test(lower)) docTotal = val;
  }

  // If we don't have inline total/subtotal, compute subtotal from items
  if (docSubtotal == null) {
    // Can't compute without items -- caller handles items
    return { tax, shipping };
  }

  // Also check for total on "Total\tAmount" type lines or "Total Amount    176.55"
  if (docTotal == null) {
    // Look for the word "total" (not "subtotal") near a number on the same line
    for (const line of lines) {
      if (/\btotal\b/i.test(line) && !/sub/i.test(line)) {
        const nums = line.match(/\d[\d,]*\.\d{2}/g)?.map((n) => parseFloat(n.replace(/,/g, "")));
        if (nums && nums.length > 0) {
          docTotal = nums[nums.length - 1]; // take last number (often "Total Amount   176.55")
        }
      }
    }
  }

  // Collect all orphan dollar amounts in the text
  const orphanAmounts = new Set<number>();
  for (const line of lines) {
    if (/^\$?([\d,]+\.\d{2})$/.test(line)) {
      orphanAmounts.add(parseFloat(line.replace(/[$,]/g, "")));
    }
  }

  // If we still don't have a total, estimate from orphans:
  // the total should be > subtotal and close to subtotal (within 2x)
  if (docTotal == null && docSubtotal != null) {
    const candidates = [...orphanAmounts].filter(
      (n) => n > docSubtotal! && n < docSubtotal! * 2
    );
    if (candidates.length === 1) {
      docTotal = candidates[0];
      console.log(`[Recovery] inferred total=${docTotal} from orphan numbers`);
    }
  }

  // Try to find tax/shipping among orphan numbers
  // We know: total = subtotal + tax + shipping
  if (docTotal != null && docTotal > docSubtotal) {
    const gap = Math.round((docTotal - docSubtotal) * 100) / 100;

    // Look for two orphan numbers that sum to the gap
    const candidates = [...orphanAmounts].filter((n) => n > 0 && n <= gap);
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const sum = Math.round((candidates[i] + candidates[j]) * 100) / 100;
        if (Math.abs(sum - gap) < 0.01) {
          // Found a pair that sums to the gap -- smaller is likely tax, larger is shipping
          // (common pattern: shipping > tax for parts orders)
          // Override LLM values even if non-zero -- math is authoritative
          const [smaller, larger] = candidates[i] < candidates[j]
            ? [candidates[i], candidates[j]]
            : [candidates[j], candidates[i]];
          tax = smaller;
          shipping = larger;
          console.log(`[Recovery] totals from math: gap=${gap}, tax=${smaller}, shipping=${larger} (total=${docTotal}, subtotal=${docSubtotal})`);
          return { tax, shipping };
        }
      }
    }

    // If only one is missing, compute it
    if (tax === 0 && shipping > 0) {
      tax = Math.round((gap - shipping) * 100) / 100;
      if (tax > 0) console.log(`[Recovery] tax computed from gap: ${tax}`);
    } else if (shipping === 0 && tax > 0) {
      shipping = Math.round((gap - tax) * 100) / 100;
      if (shipping > 0) console.log(`[Recovery] shipping computed from gap: ${shipping}`);
    }
  }

  return { tax, shipping };
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

    const recovered = recoverTotals(text, fill.totalTax ?? 0, fill.totalShipping ?? 0);
    if ((recovered.tax > 0 || recovered.shipping > 0) && result.items.length > 0) {
      distributeAndNormalize(result.items, recovered.shipping, recovered.tax);
    }
  } catch {
    // Non-critical -- items still extracted
  }
}

export async function parseDocument(
  pdfBase64: string,
  onStep: StepCallback = () => {},
  abortSignal?: AbortSignal,
  mode: string = "template",
  extractionModel?: string
): Promise<DocumentResult> {
  // Step 1: Extract text
  onStep("extracting_text", "Extracting text from PDF...");
  const buffer = Buffer.from(pdfBase64, "base64");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  await parser.destroy();

  let text = result.text.replace(/\f/g, "\n").trim();
  if (text.length < 20) {
    throw new Error("Document appears to be empty or image-only");
  }

  // Check if pdf-parse produced garbled text -- supplement with OCR if so
  const qualityIssue = textQualityPoor(text);
  if (qualityIssue) {
    console.log(`[OCR] pdf-parse quality issue: ${qualityIssue}, trying GLM OCR fallback...`);
    onStep("ocr_fallback", "Enhancing text with OCR...");
    const ocrText = await ocrExtractText(pdfBase64, abortSignal);
    if (ocrText) {
      console.log(`[OCR] supplementing (pdf-parse=${text.length} chars, ocr=${ocrText.length} chars)`);
      // Don't replace -- OCR may miss data (e.g. line items). Append so the LLM
      // gets the original text (items) plus OCR text (clean metadata/totals).
      text = text + "\n\n--- OCR-enhanced text ---\n" + ocrText;
    }
  }

  // LLM-only mode: skip template matching entirely
  if (mode === "llm") {
    return llmExtractOnly(text, onStep, abortSignal, extractionModel);
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
          return llmExtractOnly(text, onStep, abortSignal, extractionModel);
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
      return llmPath(text, onStep, abortSignal, canRegenerate ? tpl.id : undefined, extractionModel);
    }

    if (!usable) {
      if (isInCooldown(tpl)) {
        const daysLeft = Math.ceil(
          (7 * 24 * 60 * 60 * 1000 - (Date.now() - tpl.lastGenerationAttempt!.getTime())) / (24 * 60 * 60 * 1000)
        );
        onStep("template_cooldown", `Template generation for ${tpl.vendorName} failed recently. Retrying in ${daysLeft}d.`);
        return llmExtractOnly(text, onStep, abortSignal, extractionModel);
      }
      onStep("template_retry", `Retrying template generation for ${tpl.vendorName}...`);
      return llmPath(text, onStep, abortSignal, tpl.id, extractionModel);
    }

    onStep("template_failed", `Template for ${tpl.vendorName} is unreliable. Using LLM...`);
    return llmPath(text, onStep, abortSignal, tpl.id, extractionModel);
  }

  onStep("no_template", "New vendor detected. Learning template via LLM...");
  return llmPath(text, onStep, abortSignal, undefined, extractionModel);
}

/**
 * LLM extraction only -- no template generation.
 */
async function llmExtractOnly(
  text: string,
  onStep: StepCallback,
  abortSignal?: AbortSignal,
  modelOverride?: string
): Promise<DocumentResult> {
  if (!isLlmConfigured()) {
    throw new Error("No extraction template for this vendor. Set OPENAI_API_KEY to enable automatic template learning.");
  }
  if (abortSignal?.aborted) throw new Error("Request cancelled");

  const effectiveModel = modelOverride ?? "gpt-5.4-nano";
  onStep("llm_extracting", `Extracting data with ${effectiveModel}...`);
  const llmText = text.length > MAX_LLM_TEXT ? text.slice(0, MAX_LLM_TEXT) : text;
  const extraction = await llmExtract(llmText, abortSignal, modelOverride);

  const items: ExtractedItem[] = extraction.items.map((item) => ({
    partNumber: item.partNumber,
    partName: item.partName,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    shipCost: null,
    taxPrice: null,
    brand: item.brand,
  }));

  const recovered = recoverTotals(text, extraction.totalTax ?? 0, extraction.totalShipping ?? 0);
  if ((recovered.tax > 0 || recovered.shipping > 0) && items.length > 0) {
    distributeAndNormalize(items, recovered.shipping, recovered.tax);
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
  existingTemplateId?: number,
  extractionModel?: string
): Promise<DocumentResult> {
  if (!isLlmConfigured()) {
    throw new Error("No extraction template for this vendor. Set OPENAI_API_KEY to enable automatic template learning.");
  }
  if (abortSignal?.aborted) throw new Error("Request cancelled");

  // Step 1: Extract everything with nano
  const effectiveModel = extractionModel ?? "gpt-5.4-nano";
  onStep("llm_extracting", `Extracting data with ${effectiveModel}...`);
  const llmText = text.length > MAX_LLM_TEXT ? text.slice(0, MAX_LLM_TEXT) : text;
  const extraction = await llmExtract(llmText, abortSignal, extractionModel);

  const items: ExtractedItem[] = extraction.items.map((item) => ({
    partNumber: item.partNumber,
    partName: item.partName,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    shipCost: null,
    taxPrice: null,
    brand: item.brand,
  }));

  const recovered = recoverTotals(text, extraction.totalTax ?? 0, extraction.totalShipping ?? 0);
  if ((recovered.tax > 0 || recovered.shipping > 0) && items.length > 0) {
    distributeAndNormalize(items, recovered.shipping, recovered.tax);
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
  const layout = detectLayoutType(text);
  console.log(`[Layout] detected: ${layout}`);
  learnTemplateInBackground(text, llmText, extraction, existingTemplateId, columnHintFor(text, extraction), layout);

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

/** Wrap a promise with a timeout + abort signal */
function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  const controller = new AbortController();
  return Promise.race([
    fn(controller.signal),
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        controller.abort();
        reject(new Error(`${label} timed out after ${ms / 1000}s`));
      }, ms);
    }),
  ]);
}

const TEMPLATE_GEN_TIMEOUT = 15_000;  // 15s per LLM call
const TOTAL_BACKGROUND_TIMEOUT = 45_000;  // 45s total for entire background process

function learnTemplateInBackground(
  text: string,
  llmText: string,
  extraction: import("./template-llm.js").LlmExtraction,
  existingTemplateId: number | undefined,
  columnHint: string,
  layout: LayoutType
): void {
  if (columnHint) {
    console.log(`[Template] column hint:\n${columnHint}`);
  } else {
    console.log(`[Template] no column hint generated`);
  }

  const bgTask = async () => {
    try {
      const templateRules = await withTimeout(
        (sig) => llmGenerateTemplate(llmText, extraction, sig, undefined, columnHint, layout),
        TEMPLATE_GEN_TIMEOUT, "mini template gen"
      );

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

            const fixedRow = await withTimeout(
              (sig) => llmRepairRowRegex({
                expected: `partNumber=${firstItem.partNumber}, description=${firstItem.partName}, quantity=${firstItem.quantity}, unitPrice=${firstItem.unitPrice}`,
                got: validation.reason ?? "0 items matched",
                context: `Start: ${templateRules.lineItems.start}\nEnd: ${templateRules.lineItems.end}\nRow: ${templateRules.lineItems.row}\n\nExample line: ${itemContext}${annotation}`,
              }, sig),
              TEMPLATE_GEN_TIMEOUT, "row repair"
            );

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
          const escalatedRules = await withTimeout(
            (sig) => llmGenerateTemplate(llmText, extraction, sig, ESCALATION_MODEL, columnHint, layout),
            30_000, "Gemini escalation"
          );
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
  };

  // Total timeout prevents runaway background tasks
  withTimeout(() => bgTask(), TOTAL_BACKGROUND_TIMEOUT, "background template gen").catch((err) => {
    console.warn("[Template] background timed out:", err.message);
  });
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
