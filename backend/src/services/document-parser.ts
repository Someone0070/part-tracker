import { PDFParse } from "pdf-parse";
import type { DocumentResult, ExtractedItem, StepCallback, ExtractionRules } from "./template-types.js";
import type { VendorTemplate } from "./template-types.js";
import { stripBoilerplate, stripForFillIn } from "./text-preprocessing.js";
import { detectDocType, validateExtraction } from "./validation-stack.js";
import { loadAllActiveTemplates, detectVendorVersions, hasUsableRules, isInCooldown } from "./vendor-detect.js";
import { recordResult, needsSpotCheck, createTemplateVersion, type RecentResult } from "./template-lifecycle.js";
import { determineConfidenceTier, validateTemplate } from "./template-validate.js";
import { llmExtract, llmFillIn, llmGenerateTemplate, llmRepairField, isLlmConfigured, type LlmExtraction } from "./template-llm.js";
import { applyTemplate, distributeAndNormalize } from "./template-apply.js";
import { checkExtraction } from "./extraction-sanity.js";
import { deriveVendorKey } from "./template-types.js";
import RE2 from "re2";

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
      .replace(/<[^>]+>/g, " ")       // HTML tags -> space
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
 * Sanitize extraction results -- catch obviously wrong values from weaker models.
 */
function sanitizeExtraction(result: DocumentResult): void {
  // Tracking number validation: must be 10+ chars and look like a real tracking number
  if (result.trackingNumber) {
    const t = result.trackingNumber.trim();
    const looksLikeTracking =
      /^\d{10,}$/.test(t) ||                    // Pure numeric (USPS, FedEx Ground)
      /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(t) ||     // International (e.g. RR123456789CN)
      /^1Z[A-Z0-9]{16}$/.test(t) ||             // UPS
      /^\d{4}\s?\d{4}\s?\d{4}\s?\d{4}/.test(t); // Space-separated groups
    if (!looksLikeTracking) {
      console.log(`[Sanitize] rejected tracking "${t}" -- doesn't match known formats`);
      result.trackingNumber = null;
    }
  }

  // Tracking != part number or order number (weaker models confuse these)
  if (result.trackingNumber) {
    const t = result.trackingNumber.trim();
    const partNumbers = new Set(result.items.map((i) => i.partNumber));
    if (partNumbers.has(t) || t === result.orderNumber) {
      console.log(`[Sanitize] rejected tracking "${t}" -- same as part/order number`);
      result.trackingNumber = null;
    }
  }

  // Courier validation: must be a known carrier or service, not random words
  if (result.deliveryCourier) {
    const c = result.deliveryCourier.trim().toLowerCase();
    const badCouriers = ["shipped", "pending", "processing", "completed", "paid", "n/a", "none", "visa", "cash"];
    if (badCouriers.includes(c) || c.length < 2) {
      console.log(`[Sanitize] rejected courier "${result.deliveryCourier}" -- not a real carrier`);
      result.deliveryCourier = null;
    }
  }

  // Brand validation: reject if it's clearly part of a description suffix
  for (const item of result.items) {
    if (item.brand) {
      const b = item.brand.trim();
      const badBrands = ["svce", "service", "assy", "assembly", "kit", "oem", "new", "used", "repl"];
      if (badBrands.includes(b.toLowerCase()) || b.length < 2) {
        console.log(`[Sanitize] rejected brand "${b}" -- looks like description fragment`);
        item.brand = null;
      }
    }
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

const TEMPLATE_GEN_TIMEOUT = 30_000;  // 30s for GPT 5.4 (slower than mini)
const TOTAL_BACKGROUND_TIMEOUT = 60_000;  // 60s total for entire background process

// --- Helper: build DocumentResult from LlmExtraction ---

function buildDocResult(
  extraction: LlmExtraction,
  cleanText: string,
  rawText: string
): DocumentResult {
  const items: ExtractedItem[] = extraction.items.map((item) => ({
    partNumber: item.partNumber,
    partName: item.partName,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    shipCost: null,
    taxPrice: null,
    brand: item.brand,
  }));

  // Use rawText for total recovery (subtotal/total lines may be in boilerplate)
  const recovered = recoverTotals(rawText, extraction.totalTax ?? 0, extraction.totalShipping ?? 0);
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
    rawText,
  };
  fixSplitTracking(docResult);
  sanitizeExtraction(docResult);

  return docResult;
}

// --- Fill metadata using nano (for template-extracted results) ---

/**
 * Fill in metadata + totals from nano, then distribute tax/shipping to items.
 * Uses cleanText with item rows stripped for a smaller, cheaper nano call.
 * Uses rawText for total recovery (math-based).
 */
async function fillMetadata(
  result: DocumentResult,
  cleanText: string,
  rawText: string,
  matchedRowLines: string[],
  onStep: StepCallback,
  abortSignal?: AbortSignal
): Promise<void> {
  if (!isLlmConfigured()) return;

  onStep("filling_metadata", "Filling metadata with gpt-5.4-nano...");
  try {
    // Strip matched item rows + addresses from cleanText for smaller nano input
    const fillText = stripForFillIn(cleanText, matchedRowLines);
    const fill = await llmFillIn(fillText, abortSignal);

    result.orderNumber = fill.orderNumber;
    result.orderDate = fill.orderDate;
    result.technicianName = fill.technicianName;
    result.trackingNumber = fill.trackingNumber;
    result.deliveryCourier = fill.deliveryCourier;

    // Use rawText for recovery -- subtotal/total may be in boilerplate
    const recovered = recoverTotals(rawText, fill.totalTax ?? 0, fill.totalShipping ?? 0);
    if ((recovered.tax > 0 || recovered.shipping > 0) && result.items.length > 0) {
      distributeAndNormalize(result.items, recovered.shipping, recovered.tax);
    }
  } catch {
    // Non-critical -- items still extracted
  }
}

/**
 * Get the raw matched row lines from template application (for stripForFillIn).
 * We re-run the row regex to capture the actual matched text lines.
 */
function getMatchedRowLines(rawText: string, rules: ExtractionRules): string[] {
  try {
    const rowRe = new RE2(rules.lineItems.row, "g");
    const lines: string[] = [];
    let match;
    while ((match = rowRe.exec(rawText)) !== null) {
      lines.push(match[0]);
    }
    return lines;
  } catch {
    return [];
  }
}

// --- Main extraction flow ---

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

  let rawText = result.text.replace(/\f/g, "\n").trim();
  if (rawText.length < 20) {
    throw new Error("Document appears to be empty or image-only");
  }

  // Check if pdf-parse produced garbled text -- supplement with OCR if so
  const qualityIssue = textQualityPoor(rawText);
  if (qualityIssue) {
    console.log(`[OCR] pdf-parse quality issue: ${qualityIssue}, trying GLM OCR fallback...`);
    onStep("ocr_fallback", "Enhancing text with OCR...");
    const ocrText = await ocrExtractText(pdfBase64, abortSignal);
    if (ocrText) {
      console.log(`[OCR] supplementing (pdf-parse=${rawText.length} chars, ocr=${ocrText.length} chars)`);
      // Don't replace -- OCR may miss data (e.g. line items). Append so the LLM
      // gets the original text (items) plus OCR text (clean metadata/totals).
      rawText = rawText + "\n\n--- OCR-enhanced text ---\n" + ocrText;
    }
  }

  // Strip boilerplate for LLM calls (template regex still uses rawText)
  const cleanText = stripBoilerplate(rawText);

  // LLM-only mode: skip template matching entirely
  if (mode === "llm") {
    return llmExtractOnly(cleanText, rawText, onStep, abortSignal, extractionModel);
  }

  // Step 2: Detect vendor + doc type
  onStep("detecting_vendor", "Searching for vendor template...");
  const docType = detectDocType(rawText);
  const templates = await loadAllActiveTemplates();
  const matched = detectVendorVersions(rawText, templates);

  if (matched) {
    // Try each template version (newest first -- already sorted by loadAllActiveTemplates)
    const versions = matched.templates.filter((t) => hasUsableRules(t));

    for (const tpl of versions) {
      onStep("vendor_matched", `Vendor matched: ${tpl.vendorName} (v${tpl.version})`);
      onStep("applying_template", "Applying learned template...");

      // Apply template regex to rawText (templates are built against raw text)
      const extracted = applyTemplate(rawText, tpl.extractionRules);

      if (extracted.items.length === 0) {
        console.log(`[Template] v${tpl.version} extracted 0 items, trying next version`);
        recordResult(tpl.id, false).catch(() => {});
        continue;
      }

      // Sanity pre-check (not scored -- basic structural checks)
      const sanity = checkExtraction(extracted);
      if (!sanity.pass) {
        console.warn(`[Template] v${tpl.version} sanity FAILED (score=${sanity.score}):`, sanity.failures);
        recordResult(tpl.id, false).catch(() => {});
        continue;
      }

      // Scored validation via validation stack
      const validation = validateExtraction(extracted.items, rawText, docType);

      if (validation.pass === true) {
        // Definitive pass -- serve result
        recordResult(tpl.id, true).catch(() => {});

        const matchedRows = getMatchedRowLines(rawText, tpl.extractionRules);
        await fillMetadata(extracted, cleanText, rawText, matchedRows, onStep, abortSignal);
        fixSplitTracking(extracted);
        sanitizeExtraction(extracted);

        onStep("done", `${extracted.items.length} item${extracted.items.length !== 1 ? "s" : ""} extracted`);
        return extracted;
      }

      if (validation.pass === null) {
        // Unverified -- check if spot check is needed
        const recentResults = JSON.parse(tpl.recentResults) as RecentResult[];
        const spotCheckNeeded = needsSpotCheck(recentResults);

        if (spotCheckNeeded && isLlmConfigured()) {
          // Run nano in parallel with fill-in to verify
          onStep("spot_check", "Running spot check...");
          const llmText = cleanText.length > MAX_LLM_TEXT ? cleanText.slice(0, MAX_LLM_TEXT) : cleanText;

          try {
            const nanoExtraction = await llmExtract(llmText, abortSignal);
            const tplPNs = new Set(extracted.items.map((i) => i.partNumber));
            const nanoPNs = nanoExtraction.items.map((i) => i.partNumber).filter(Boolean);

            let agrees = true;
            if (nanoExtraction.items.length > extracted.items.length) agrees = false;
            for (const pn of nanoPNs) {
              if (!tplPNs.has(pn)) { agrees = false; break; }
            }

            if (agrees) {
              recordResult(tpl.id, true).catch(() => {});
            } else {
              console.warn(`[SpotCheck] v${tpl.version} FAILED: template=${extracted.items.length} items, nano=${nanoExtraction.items.length} items`);
              recordResult(tpl.id, false).catch(() => {});

              // Serve nano result instead
              const nanoResult = buildDocResult(nanoExtraction, cleanText, rawText);
              onStep("done", `${nanoResult.items.length} item${nanoResult.items.length !== 1 ? "s" : ""} extracted`);

              // Trigger background repair/regen against the failed template
              const layout = detectLayoutType(rawText);
              triggerBackgroundRepairOrRegen(rawText, cleanText, extracted, nanoExtraction, tpl, layout);

              return nanoResult;
            }
          } catch {
            // Spot check failed (LLM error) -- record null, serve template result
            recordResult(tpl.id, null).catch(() => {});
          }
        } else {
          // No spot check needed -- record null (unverified)
          recordResult(tpl.id, null).catch(() => {});
        }

        // Serve template result (either spot check passed or not needed)
        const matchedRows = getMatchedRowLines(rawText, tpl.extractionRules);
        await fillMetadata(extracted, cleanText, rawText, matchedRows, onStep, abortSignal);
        fixSplitTracking(extracted);
        sanitizeExtraction(extracted);

        onStep("done", `${extracted.items.length} item${extracted.items.length !== 1 ? "s" : ""} extracted`);
        return extracted;
      }

      // validation.pass === false -- try next version
      console.warn(`[Template] v${tpl.version} validation FAILED:`, validation.reason);
      recordResult(tpl.id, false).catch(() => {});
    }

    // All versions failed -- fall through to nano extraction
    onStep("template_failed", "All template versions failed. Falling back to LLM...");
  } else {
    onStep("no_template", "New vendor detected. Extracting with LLM...");
  }

  // LLM fallback -- extract with nano, trigger background template learning
  return llmFallback(cleanText, rawText, onStep, abortSignal, extractionModel);
}

// --- LLM extraction only (no template generation) ---

async function llmExtractOnly(
  cleanText: string,
  rawText: string,
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
  const llmText = cleanText.length > MAX_LLM_TEXT ? cleanText.slice(0, MAX_LLM_TEXT) : cleanText;
  const extraction = await llmExtract(llmText, abortSignal, modelOverride);

  const docResult = buildDocResult(extraction, cleanText, rawText);
  onStep("done", `${docResult.items.length} item${docResult.items.length !== 1 ? "s" : ""} extracted`);
  return docResult;
}

// --- LLM fallback with background template learning ---

async function llmFallback(
  cleanText: string,
  rawText: string,
  onStep: StepCallback,
  abortSignal?: AbortSignal,
  extractionModel?: string
): Promise<DocumentResult> {
  if (!isLlmConfigured()) {
    throw new Error("No extraction template for this vendor. Set OPENAI_API_KEY to enable automatic template learning.");
  }
  if (abortSignal?.aborted) throw new Error("Request cancelled");

  const effectiveModel = extractionModel ?? "gpt-5.4-nano";
  onStep("llm_extracting", `Extracting data with ${effectiveModel}...`);
  const llmText = cleanText.length > MAX_LLM_TEXT ? cleanText.slice(0, MAX_LLM_TEXT) : cleanText;
  const extraction = await llmExtract(llmText, abortSignal, extractionModel);

  const docResult = buildDocResult(extraction, cleanText, rawText);
  onStep("done", `${docResult.items.length} item${docResult.items.length !== 1 ? "s" : ""} extracted`);

  // Template generation runs in background -- don't block the response
  const layout = detectLayoutType(rawText);
  console.log(`[Layout] detected: ${layout}`);
  learnTemplateInBackground(rawText, cleanText, extraction, layout);

  return docResult;
}

// --- Background template learning (single-shot GPT 5.4) ---

function learnTemplateInBackground(
  rawText: string,
  cleanText: string,
  extraction: LlmExtraction,
  layout: LayoutType
): void {
  const columnHint = columnHintFor(rawText, extraction);
  if (columnHint) {
    console.log(`[Template] column hint:\n${columnHint}`);
  } else {
    console.log(`[Template] no column hint generated`);
  }

  const bgTask = async () => {
    try {
      const llmText = cleanText.length > MAX_LLM_TEXT ? cleanText.slice(0, MAX_LLM_TEXT) : cleanText;
      const templateRules = await withTimeout(
        (sig) => llmGenerateTemplate(llmText, extraction, sig, columnHint, layout),
        TEMPLATE_GEN_TIMEOUT, "template gen"
      );

      // Determine confidence tier
      const textPartNumbers = findPartNumbers(rawText);
      const tier = determineConfidenceTier(extraction, rawText, textPartNumbers);
      console.log(`[Template] confidence tier: ${tier}`);

      if (tier === 3) {
        console.warn("[Template] tier 3 (no confidence) -- skipping save");
        return;
      }

      // Validate against nano extraction
      const validation = validateTemplate(rawText, templateRules, extraction, tier);
      if (validation.valid) {
        const vendorKey = deriveVendorKey(templateRules.vendorSignals);
        const newId = await createTemplateVersion(vendorKey, templateRules);
        console.log(`[Template] learned for ${templateRules.vendorName} (id=${newId}, tier=${tier})`);
      } else {
        console.warn("[Template] validation failed:", validation.reason);
      }
    } catch (err) {
      console.warn("[Template] background generation failed:", err);
    }
  };

  // Total timeout prevents runaway background tasks
  withTimeout(() => bgTask(), TOTAL_BACKGROUND_TIMEOUT, "background template gen").catch((err) => {
    console.warn("[Template] background timed out:", err.message);
  });
}

// --- Background repair/regeneration ---

function triggerBackgroundRepairOrRegen(
  rawText: string,
  cleanText: string,
  templateResult: DocumentResult,
  nanoExtraction: LlmExtraction,
  template: VendorTemplate,
  layout: LayoutType
): void {
  const bgTask = async () => {
    try {
      // Skip if template is in cooldown
      if (isInCooldown(template)) {
        console.log(`[Repair] ${template.vendorName} in cooldown, skipping`);
        return;
      }

      // Determine confidence tier
      const textPartNumbers = findPartNumbers(rawText);
      const tier = determineConfidenceTier(nanoExtraction, rawText, textPartNumbers);
      console.log(`[Repair] confidence tier: ${tier}`);

      if (tier === 3) {
        console.warn("[Repair] tier 3 (no confidence) -- skipping");
        return;
      }

      // Diff template vs nano: same part numbers = field repair, different = regenerate
      const tplPNs = new Set(templateResult.items.map((i) => i.partNumber));
      const nanoPNs = new Set(nanoExtraction.items.map((i) => i.partNumber).filter(Boolean));

      const samePartNumbers =
        tplPNs.size === nanoPNs.size &&
        [...nanoPNs].every((pn) => tplPNs.has(pn));

      if (samePartNumbers && tier === 1) {
        // Field repair (tier 1 only for prices) -- part numbers match but prices differ
        console.log("[Repair] same part numbers, attempting field repair...");

        // Find mismatched price fields
        const priceIssues: Array<{ partNumber: string; expected: string; got: string }> = [];
        for (const nanoItem of nanoExtraction.items) {
          if (nanoItem.unitPrice == null) continue;
          const tplItem = templateResult.items.find((i) => i.partNumber === nanoItem.partNumber);
          if (!tplItem || tplItem.unitPrice == null) continue;
          if (Math.abs(tplItem.unitPrice - nanoItem.unitPrice) > 0.01) {
            priceIssues.push({
              partNumber: nanoItem.partNumber,
              expected: String(nanoItem.unitPrice),
              got: String(tplItem.unitPrice),
            });
          }
        }

        if (priceIssues.length > 0) {
          // Get context around the first mismatched item
          const firstIssue = priceIssues[0];
          const contextLine = rawText.split("\n").find((l) => l.includes(firstIssue.partNumber)) ?? "";

          const fixedRegex = await withTimeout(
            (sig) => llmRepairField(
              "unitPrice",
              template.extractionRules.lineItems.row,
              priceIssues,
              contextLine,
              sig
            ),
            TEMPLATE_GEN_TIMEOUT, "field repair"
          );

          if (fixedRegex) {
            const repairedRules = {
              ...template.extractionRules,
              lineItems: { ...template.extractionRules.lineItems, row: fixedRegex },
            };

            const revalidation = validateTemplate(rawText, repairedRules, nanoExtraction, tier);
            if (revalidation.valid) {
              const newId = await createTemplateVersion(template.vendorKey, repairedRules);
              console.log(`[Repair] field repair saved as new version (id=${newId})`);
              return;
            } else {
              console.warn("[Repair] repaired template failed validation:", revalidation.reason);
            }
          }
        }
      }

      // Regeneration: generate entirely new template
      console.log("[Repair] regenerating template...");
      const llmText = cleanText.length > MAX_LLM_TEXT ? cleanText.slice(0, MAX_LLM_TEXT) : cleanText;
      const columnHint = columnHintFor(rawText, nanoExtraction);

      const newRules = await withTimeout(
        (sig) => llmGenerateTemplate(llmText, nanoExtraction, sig, columnHint, layout),
        TEMPLATE_GEN_TIMEOUT, "template regen"
      );

      const regenValidation = validateTemplate(rawText, newRules, nanoExtraction, tier);
      if (regenValidation.valid) {
        const newId = await createTemplateVersion(template.vendorKey, newRules);
        console.log(`[Repair] regenerated template saved as new version (id=${newId})`);
      } else {
        console.warn("[Repair] regenerated template failed validation:", regenValidation.reason);
      }
    } catch (err) {
      console.warn("[Repair] background repair/regen failed:", err);
    }
  };

  withTimeout(() => bgTask(), TOTAL_BACKGROUND_TIMEOUT, "background repair/regen").catch((err) => {
    console.warn("[Repair] background timed out:", err.message);
  });
}
