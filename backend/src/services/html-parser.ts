import * as cheerio from "cheerio";
import { findPartNumbers, findBrand, distributeAndNormalize } from "./document-parser.js";
import type { DocumentResult, ExtractedItem } from "./document-parser.js";
import type { HtmlSelectorConfig } from "./vendor-presets.js";
import {
  validateExtractionResult,
  computePageFingerprint,
  tryPresetParse,
  savePreset,
  recordPresetSuccess,
  recordPresetFailure,
} from "./vendor-presets.js";

// --- Redaction ---

/**
 * Strip HTML to text for LLM extraction.
 * Removes scripts/styles/nav/footer but keeps order content intact.
 * Only redacts PII (names, emails, addresses, card numbers).
 */
export function redactForLlm(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, iframe, svg").remove();
  $("nav, footer, [role='navigation'], [role='banner']").remove();

  let text = $.text();

  text = text
    .replace(/[\w.-]+@[\w.-]+\.\w{2,}/g, "[EMAIL]")
    .replace(/\b(?!\d{3}-\d{7}-\d{7})\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, "[PHONE]")
    .replace(/\b\d+\s+[A-Z][a-z]+\s+(St|Ave|Rd|Blvd|Dr|Ln|Ct|Way|Pl|Cir|Street|Avenue|Road|Drive|Lane|Boulevard)\b[^,]*/gi, "[ADDRESS]")
    .replace(/ending in \d{4}/gi, "ending in [XXXX]");

  text = text.replace(/\s+/g, " ").trim();
  return text.slice(0, 8000);
}

export function scrubHtmlForSelectors(html: string): string {
  const $ = cheerio.load(html);

  $("script, style, noscript, iframe, svg").remove();

  const KEEP_ATTRS = new Set(["id", "class", "role", "data-testid", "type", "name", "for"]);
  $("*").each((_, el) => {
    const $el = $(el);
    const attrs = (el as any).attribs || {};
    for (const attr of Object.keys(attrs)) {
      if (!KEEP_ATTRS.has(attr)) {
        $el.removeAttr(attr);
      }
    }
  });

  $("input[type='hidden']").remove();
  $("meta").remove();

  const result = $.html();
  return result.replace(/<!--[\s\S]*?-->/g, "").slice(0, 8000);
}

// --- Generic selector-based parser ---

export function parseHtmlWithSelectors(
  html: string,
  config: HtmlSelectorConfig,
  vendorName: string
): DocumentResult {
  const $ = cheerio.load(html);

  const orderNumber = config.orderFields?.orderNumber
    ? $(config.orderFields.orderNumber).first().text().trim() || null
    : null;
  const orderDate = config.orderFields?.orderDate
    ? $(config.orderFields.orderDate).first().text().trim() || null
    : null;
  const technicianName = config.orderFields?.technicianName
    ? $(config.orderFields.technicianName).first().text().trim() || null
    : null;
  const trackingNumber = config.orderFields?.trackingNumber
    ? $(config.orderFields.trackingNumber).first().text().trim() || null
    : null;
  const deliveryCourier = config.orderFields?.deliveryCourier
    ? $(config.orderFields.deliveryCourier).first().text().trim() || null
    : null;

  const items: ExtractedItem[] = [];
  $(config.itemContainer).each((_, el) => {
    const $item = $(el);
    const partNameText = $item.find(config.fields.partName).text().trim();
    const qtyText = $item.find(config.fields.quantity).text().trim();
    const priceText = $item.find(config.fields.unitPrice).text().trim();
    const partNumberText = config.fields.partNumber
      ? $item.find(config.fields.partNumber).text().trim()
      : "";

    const quantity = parseInt(qtyText) || 1;
    const unitPrice = parseFloat(priceText.replace(/[^0-9.]/g, "")) || null;
    const partNumbers = findPartNumbers(partNumberText || partNameText);

    items.push({
      partNumber: partNumbers[0] ?? "",
      partName: partNameText.slice(0, 200),
      quantity,
      unitPrice,
      shipCost: null,
      taxPrice: null,
      brand: findBrand(partNameText) ?? null,
    });
  });

  const totalShipping = config.orderFields?.totalShipping
    ? parseFloat($(config.orderFields.totalShipping).first().text().replace(/[^0-9.]/g, "")) || 0
    : 0;
  const totalTax = config.orderFields?.totalTax
    ? parseFloat($(config.orderFields.totalTax).first().text().replace(/[^0-9.]/g, "")) || 0
    : 0;
  distributeAndNormalize(items, totalShipping, totalTax);

  return {
    vendor: vendorName,
    orderNumber,
    orderDate,
    technicianName,
    trackingNumber,
    deliveryCourier,
    items,
    rawText: redactForLlm(html),
  };
}

// --- Unified parse chain ---
// 1. Learned CSS preset (free, instant)
// 2. LLM extraction (nano, works on any website, learns selectors for next time)

export interface ParseChainResult {
  result: DocumentResult;
  source: "preset" | "llm" | "empty";
}

export async function parseHtmlChain(
  html: string,
  hostname: string,
  vendorKey: string,
  vendorName: string,
  llmFallback: (html: string) => Promise<DocumentResult | null>,
  onLearnSelectors?: (llmResult: DocumentResult, html: string, vendorKey: string, fingerprint: string) => Promise<void>
): Promise<ParseChainResult> {
  const fingerprint = computePageFingerprint(html);

  // Stage 1: Saved preset (learned CSS selectors)
  const presetData = await tryPresetParse(vendorKey, "html", fingerprint);
  if (presetData && presetData.config.type === "html") {
    const presetResult = parseHtmlWithSelectors(html, presetData.config, vendorName);
    const validation = validateExtractionResult(presetResult);
    console.log(`[HTMLParse] Preset: ${presetResult.items.length} items, valid=${validation.valid}`);
    if (validation.valid) {
      await recordPresetSuccess(presetData.preset.id);
      return { result: presetResult, source: "preset" };
    }
    await recordPresetFailure(presetData.preset.id);
  } else {
    console.log(`[HTMLParse] No preset for ${vendorKey}`);
  }

  // Stage 2: LLM extraction (works on any website)
  const llmResult = await llmFallback(html);
  console.log(`[HTMLParse] LLM: ${llmResult ? `${llmResult.items.length} items` : "null"}`);
  if (llmResult) {
    const validation = validateExtractionResult(llmResult);
    if (validation.valid) {
      // Learn CSS selectors in background for future free extractions
      onLearnSelectors?.(llmResult, html, vendorKey, fingerprint).catch((err) => {
        console.error("Selector learning failed:", err);
      });
      return { result: llmResult, source: "llm" };
    }
    console.warn(`[HTMLParse] LLM result invalid:`, validation.issues);
  }

  return {
    result: {
      vendor: vendorName,
      orderNumber: null,
      orderDate: null,
      technicianName: null,
      trackingNumber: null,
      deliveryCourier: null,
      items: [],
      rawText: redactForLlm(html),
    },
    source: "empty",
  };
}
