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

export function redactForLlm(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, iframe, svg").remove();
  $("nav, footer, header, [role='navigation'], [role='banner']").remove();
  $("[class*='address'], [class*='shipping'], [class*='billing'], [class*='payment']").remove();
  $("[class*='ship-to'], [class*='payment-method'], [class*='buyer-info']").remove();

  let text = $.text();

  text = text
    .replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\s*\n\s*\d+\s+[A-Z]/g, "[NAME]\n[ADDRESS]")
    .replace(/[\w.-]+@[\w.-]+\.\w{2,}/g, "[EMAIL]")
    .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, "[PHONE]")
    .replace(/\b\d+\s+[A-Z][a-z]+\s+(St|Ave|Rd|Blvd|Dr|Ln|Ct|Way|Pl|Cir|Street|Avenue|Road|Drive|Lane|Boulevard)\b[^,]*/gi, "[ADDRESS]")
    .replace(/ending in \d{4}/gi, "ending in [XXXX]");

  text = text.replace(/\s+/g, " ").trim();
  return text.slice(0, 6000);
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

  $("[class*='address'], [class*='shipping'], [class*='billing'], [class*='payment']")
    .each(function (this: any) {
      $(this).contents().filter(function (this: any) { return this.type === "text"; })
        .each(function (this: any) { $(this).replaceWith("[REDACTED]"); });
      $(this).find("*").contents().filter(function (this: any) { return this.type === "text"; })
        .each(function (this: any) { $(this).replaceWith("[REDACTED]"); });
    });

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

// --- Hardcoded vendor parsers ---

const AMAZON_HTML_CONFIG: HtmlSelectorConfig = {
  type: "html",
  itemContainer: ".a-fixed-left-grid.shipment, .a-fixed-left-grid-inner",
  fields: {
    partName: ".yohtmlc-product-title",
    unitPrice: ".a-color-price",
    quantity: ".item-view-qty",
  },
  orderFields: {
    orderNumber: ".order-date-invoice-item .a-color-secondary",
    orderDate: ".order-date-invoice-item span",
    totalShipping: ".shipping-total",
    totalTax: ".tax-total",
  },
};

const EBAY_HTML_CONFIG: HtmlSelectorConfig = {
  type: "html",
  itemContainer: ".line-item",
  fields: {
    partName: ".item-title",
    unitPrice: ".item-price",
    quantity: ".item-qty",
  },
  orderFields: {
    orderNumber: ".order-number",
    orderDate: ".order-date",
    totalShipping: ".shipping-cost",
    totalTax: ".tax-amount",
  },
};

function detectKnownVendorHtml(hostname: string): HtmlSelectorConfig | null {
  const host = hostname.toLowerCase();
  if (host.includes("amazon")) return AMAZON_HTML_CONFIG;
  if (host.includes("ebay")) return EBAY_HTML_CONFIG;
  return null;
}

// --- Unified parse chain ---

export interface ParseChainResult {
  result: DocumentResult;
  source: "hardcoded" | "preset" | "llm" | "empty";
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

  // Stage 1: Hardcoded parser
  const hardcodedConfig = detectKnownVendorHtml(hostname);
  if (hardcodedConfig) {
    const hardcodedResult = parseHtmlWithSelectors(html, hardcodedConfig, vendorName);
    const validation = validateExtractionResult(hardcodedResult);
    if (validation.valid) {
      return { result: hardcodedResult, source: "hardcoded" };
    }
  }

  // Stage 2: Saved preset
  const presetData = await tryPresetParse(vendorKey, "html", fingerprint);
  if (presetData && presetData.config.type === "html") {
    const presetResult = parseHtmlWithSelectors(html, presetData.config, vendorName);
    const validation = validateExtractionResult(presetResult);
    if (validation.valid) {
      await recordPresetSuccess(presetData.preset.id);
      return { result: presetResult, source: "preset" };
    }
    await recordPresetFailure(presetData.preset.id);
  }

  // Stage 3: LLM fallback
  const llmResult = await llmFallback(html);
  if (llmResult) {
    const validation = validateExtractionResult(llmResult);
    if (validation.valid) {
      onLearnSelectors?.(llmResult, html, vendorKey, fingerprint).catch((err) => {
        console.error("Selector learning failed:", err);
      });
      return { result: llmResult, source: "llm" };
    }
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
