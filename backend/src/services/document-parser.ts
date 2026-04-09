import { PDFParse } from "pdf-parse";
import crypto from "node:crypto";
import { getDb } from "../db/index.js";
import { vendorPresets } from "../db/schema.js";
import { sql } from "drizzle-orm";
import {
  validateExtractionResult,
  computePdfFingerprint,
  savePreset,
  recordPresetSuccess,
  recordPresetFailure,
} from "./vendor-presets.js";
import type { PdfRegexConfig } from "./vendor-presets.js";

export interface ExtractedItem {
  partNumber: string;
  partName: string;
  quantity: number;
  unitPrice: number | null;
  shipCost: number | null;
  taxPrice: number | null;
  brand: string | null;
}

export interface DocumentResult {
  vendor: string;
  orderNumber: string | null;
  orderDate: string | null;
  technicianName: string | null;
  trackingNumber: string | null;
  deliveryCourier: string | null;
  items: ExtractedItem[];
  rawText: string;
}

// --- Part number patterns ---

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

function parseDollar(text: string): number | null {
  const m = text.match(/\$(\d+\.?\d*)/);
  return m ? parseFloat(m[1]) : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Distribute shipping and tax proportionally by each item's share of the subtotal,
 * then normalize all prices to per-unit (divide by quantity).
 */
export function distributeAndNormalize(
  items: ExtractedItem[],
  totalShipping: number,
  totalTax: number
): void {
  // Compute subtotal (sum of unitPrice * quantity for all items)
  const subtotal = items.reduce(
    (sum, item) => sum + (item.unitPrice ?? 0) * item.quantity,
    0
  );

  for (const item of items) {
    const lineTotal = (item.unitPrice ?? 0) * item.quantity;
    const fraction = subtotal > 0 ? lineTotal / subtotal : 1 / items.length;

    // Proportional share of shipping and tax for this line item
    const lineShip = round2(totalShipping * fraction);
    const lineTax = round2(totalTax * fraction);

    // Normalize everything to per-unit
    const qty = item.quantity || 1;
    item.unitPrice = item.unitPrice != null ? round2(item.unitPrice) : null;
    item.shipCost = round2(lineShip / qty);
    item.taxPrice = round2(lineTax / qty);
  }
}

// --- Amazon Template ---

function parseAmazon(text: string): DocumentResult {
  const orderMatch = text.match(/Order\s*#?\s*(\d{3}-\d{7}-\d{7})/);
  const dateMatch = text.match(/Order Placed:\s*(.+)/);

  const shipNameMatch = text.match(/Shipping Address:\s*\n([^\n]+)/);
  const technicianName = shipNameMatch?.[1]?.trim() ?? null;

  const speedMatch = text.match(/Shipping Speed:\s*\n([^\n]+)/);
  const deliveryCourier = speedMatch?.[1]?.trim() ?? null;

  // Split into shipment blocks — each starts with "Items Ordered"
  const shipmentBlocks = text.split(/Items Ordered\s*Price\n?/).slice(1);

  const items: ExtractedItem[] = [];

  for (const shipBlock of shipmentBlocks) {
    // Extract this shipment's shipping and tax
    const shipMatch = shipBlock.match(/Shipping & Handling:\s*\$(\d+\.?\d*)/);
    const taxMatch = shipBlock.match(/Sales Tax:\s*\$(\d+\.?\d*)/);
    const blockShipping = shipMatch ? parseFloat(shipMatch[1]) : 0;
    const blockTax = taxMatch ? parseFloat(taxMatch[1]) : 0;

    // Extract items from this shipment block
    const blockItems: ExtractedItem[] = [];
    // split produces: [preamble, qty, itemBlock, qty, itemBlock, ...]
    const segments = shipBlock.split(/(\d+)\s+of:\s*/);

    for (let i = 1; i < segments.length - 1; i += 2) {
      const quantity = parseInt(segments[i]) || 1;
      const block = segments[i + 1];
      if (!block) continue;

      const descLine = block.split("\n")[0].trim();
      const partNumbers = findPartNumbers(block);
      const brand = findBrand(block);

      const conditionPrice = block.match(/Condition:\s*\w+\n\$(\d+\.?\d*)/);
      let price: number | null = null;
      if (conditionPrice) {
        price = parseFloat(conditionPrice[1]);
      } else {
        const standalone = block.match(/^\$(\d+\.?\d*)\s*$/m);
        if (standalone) price = parseFloat(standalone[1]);
      }

      blockItems.push({
        partNumber: partNumbers[0] ?? "",
        partName: descLine.slice(0, 200),
        quantity,
        unitPrice: price,
        shipCost: null,
        taxPrice: null,
        brand,
      });
    }

    distributeAndNormalize(blockItems, blockShipping, blockTax);
    items.push(...blockItems);
  }

  return {
    vendor: "amazon",
    orderNumber: orderMatch?.[1] ?? null,
    orderDate: dateMatch?.[1]?.trim() ?? null,
    technicianName,
    trackingNumber: null,
    deliveryCourier,
    items,
    rawText: text,
  };
}

// --- eBay Template ---

function parseEbay(text: string): DocumentResult {
  const orderMatch = text.match(/Order number:\s*(\S+)/);
  const dateMatch = text.match(/Placed on\s*[\t\n]\s*(.+)/);

  // Technician = shipping address name
  const shipMatch = text.match(/Shipping address\s*\n([^\n]+)/);
  const technicianName = shipMatch?.[1]?.trim() ?? null;

  // Shipping cost
  const shippingMatch = text.match(/Shipping\s*[\t]\s*(?:Free|\$(\d+\.?\d*))/i);
  const totalShipping = shippingMatch?.[1] ? parseFloat(shippingMatch[1]) : 0;

  // Tax
  const taxMatch = text.match(/Tax\*?\s*[\t]\s*\$(\d+\.?\d*)/);
  const totalTax = taxMatch ? parseFloat(taxMatch[1]) : 0;

  // Courier from shipping service in item lines
  let deliveryCourier: string | null = null;

  const items: ExtractedItem[] = [];

  const cleaned = text
    .replace(/Page \d+ of \d+\tabout:srcdoc/g, "")
    .replace(/-- \d+ of \d+ --/g, "");

  const sections = cleaned.split(/Items bought from/i);

  for (let s = 1; s < sections.length; s++) {
    const section = sections[s];
    const afterHeaders = section.split(/Item\s*\n?price/i)[1];
    if (!afterHeaders) continue;

    const lines = afterHeaders.split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      const qtyMatch = line.match(/^(\d+)\s+(.+)/);
      if (!qtyMatch) { i++; continue; }

      const qty = parseInt(qtyMatch[1]);
      let itemBlock = qtyMatch[2];
      let price: number | null = null;

      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const priceLine = lines[j];
        const pm = priceLine.match(/\$(\d+\.?\d*)/);
        if (pm) {
          price = parseFloat(pm[1]);
          itemBlock += " " + priceLine.replace(/\$\d+\.?\d*/, "").trim();
          i = j + 1;
          break;
        }
        itemBlock += " " + priceLine.trim();
      }
      if (price === null) {
        const inlinePrice = itemBlock.match(/\t\$(\d+\.?\d*)/);
        if (inlinePrice) {
          price = parseFloat(inlinePrice[1]);
          itemBlock = itemBlock.replace(/\t\$\d+\.?\d*/, "");
        }
        i++;
      }

      // Extract courier from shipping method in item text
      const courierMatch = itemBlock.match(/\b(eBay\s+\w+|USPS|UPS|FedEx|DHL)\b/i);
      if (courierMatch && !deliveryCourier) deliveryCourier = courierMatch[0].trim();

      const partNumbers = findPartNumbers(itemBlock);
      const brand = findBrand(itemBlock);
      const cleanName = itemBlock
        .replace(/\(\d{10,}\)/, "")
        .replace(/\beBay\s+\w+\b/i, "")
        .replace(/\t/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (cleanName || partNumbers.length > 0) {
        items.push({
          partNumber: partNumbers[0] ?? "",
          partName: cleanName.slice(0, 200),
          quantity: qty,
          unitPrice: price,
          shipCost: null,
          taxPrice: null,
          brand,
        });
      }
    }
  }

  distributeAndNormalize(items, totalShipping, totalTax);

  return {
    vendor: "ebay",
    orderNumber: orderMatch?.[1] ?? null,
    orderDate: dateMatch?.[1]?.trim() ?? null,
    technicianName,
    trackingNumber: null,
    deliveryCourier,
    items,
    rawText: text,
  };
}

// --- Marcone Template ---

function parseMarcone(text: string): DocumentResult {
  const invoiceMatch = text.match(/Invoice:\s*(\d+)/);
  const dateMatch = text.match(/Invoice Date:\s*(.+)/);

  // Technician = Ship To person name (not company)
  // Marcone Ship To section has company address first, then actual recipient
  // Look for a name-like line near the physical shipping address
  const shipToSection = text.split(/Ship To:/i)[1]?.split(/Remit Payment/i)[0] ?? "";
  let technicianName: string | null = null;
  if (shipToSection) {
    const shipLines = shipToSection.split("\n").map((l) => l.trim()).filter(Boolean);
    // Walk backwards - the actual recipient name is usually near the end, before "Remit Payment"
    // It's a short all-alpha line that isn't an address
    for (let i = shipLines.length - 1; i >= 0; i--) {
      const line = shipLines[i];
      if (/^\d/.test(line)) continue; // address line
      if (/,\s*[A-Z]{2}\s+\d{5}/.test(line)) continue; // city, state zip
      if (/\b(LLC|INC|CORP|LTD)\b/i.test(line)) continue; // company
      if (/^UNIT\b/i.test(line)) continue; // unit number
      if (line.length > 2 && line.length < 40 && /^[A-Z\s.'-]+$/i.test(line)) {
        technicianName = line;
        break;
      }
    }
  }

  // Tracking number
  const trackingMatch = text.match(/Tracking\s*#?\s*[\t\s]*(?:\*+\s*[\t\s]*)?(\d{10,})/);
  const trackingNumber = trackingMatch?.[1] ?? null;

  // Shipping (Delivery) and Tax — Marcone stacks labels then values:
  //   SubTotal:\nSales Tax:\nDelivery:\nHandling:\nC.O.D. Fee:\nInvoice Total:\n$88.83\n$8.44\n$13.49\n$0.00\n$0.00\n$110.76
  let totalShipping = 0;
  let totalTax = 0;
  // Grab from SubTotal through the dollar values that follow Invoice Total
  const subSection = text.match(/SubTotal:[\s\S]*?Invoice Total:\s*(?:\n\$[\d.]+)+/);
  if (subSection) {
    const block = subSection[0];
    const labels = [...block.matchAll(/(SubTotal|Sales Tax|Delivery|Handling|C\.O\.D\.\s*Fee|Invoice Total):/gi)]
      .map((m) => m[1].toLowerCase());
    const values = [...block.matchAll(/\$(\d+\.?\d*)/g)].map((m) => parseFloat(m[1]));
    const taxIdx = labels.indexOf("sales tax");
    const deliveryIdx = labels.indexOf("delivery");
    if (taxIdx >= 0 && taxIdx < values.length) totalTax = values[taxIdx];
    if (deliveryIdx >= 0 && deliveryIdx < values.length) totalShipping = values[deliveryIdx];
  }

  const items: ExtractedItem[] = [];

  const lines = text.split("\n");
  for (const line of lines) {
    if (!/^\d+\s*\t/.test(line)) continue;
    if (!/\$/.test(line)) continue;

    const cols = line.split("\t").map((c) => c.trim());
    const quantity = parseInt(cols[0]) || 1;
    let partNumber = "";
    let description = "";
    const prices: number[] = [];

    for (const col of cols.slice(1)) {
      const priceMatch = col.match(/^\$(\d+\.?\d*)/);
      if (priceMatch) { prices.push(parseFloat(priceMatch[1])); continue; }
      const pns = findPartNumbers(col);
      if (pns.length > 0 && !partNumber) { partNumber = pns[0]; continue; }
      if (/^\d+$/.test(col)) continue;
      if (col && !description) description = col;
    }

    if (partNumber || description) {
      items.push({
        partNumber,
        partName: description,
        quantity,
        unitPrice: prices[0] ?? null,
        shipCost: null,
        taxPrice: null,
        brand: null,
      });
    }
  }

  // Fallback if table parsing found nothing
  if (items.length === 0) {
    const partNumbers = findPartNumbers(text);
    const descMatch = text.match(/Description[\s\S]*?\t([A-Z][A-Z\s/\-,.]+)/);
    const description = descMatch?.[1]?.trim() ?? "";
    const priceMatch = text.match(/\$(\d+\.?\d{2})/);

    for (const pn of partNumbers) {
      items.push({
        partNumber: pn,
        partName: description,
        quantity: 1,
        unitPrice: priceMatch ? parseFloat(priceMatch[1]) : null,
        shipCost: null,
        taxPrice: null,
        brand: null,
      });
    }
  }

  distributeAndNormalize(items, totalShipping, totalTax);

  return {
    vendor: "marcone",
    orderNumber: invoiceMatch?.[1] ?? null,
    orderDate: dateMatch?.[1]?.trim() ?? null,
    technicianName,
    trackingNumber,
    deliveryCourier: null,
    items,
    rawText: text,
  };
}

// --- LLM Fallback ---

const ZAI_CHAT_URL = "https://api.z.ai/api/paas/v4/chat/completions";

export async function parseFallback(text: string): Promise<DocumentResult> {
  const apiKey = process.env.ZAI_API_KEY;
  const empty: DocumentResult = {
    vendor: "unknown",
    orderNumber: null,
    orderDate: null,
    technicianName: null,
    trackingNumber: null,
    deliveryCourier: null,
    items: findPartNumbers(text).map((pn) => ({
      partNumber: pn,
      partName: "",
      quantity: 1,
      unitPrice: null,
      shipCost: null,
      taxPrice: null,
      brand: null,
    })),
    rawText: text,
  };

  if (!apiKey) return empty;

  try {
    const res = await fetch(ZAI_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "glm-4-flash-250414",
        temperature: 0,
        max_tokens: 1000,
        messages: [
          {
            role: "system",
            content:
              "You extract purchase order line items from document text. Reply ONLY with valid JSON, no markdown.",
          },
          {
            role: "user",
            content: `Extract all purchased items from this document. Reply with JSON: {"vendor":"...","orderNumber":"...","orderDate":"...","technicianName":"...","trackingNumber":"...","deliveryCourier":"...","items":[{"partNumber":"...","partName":"...","quantity":1,"unitPrice":null,"shipCost":null,"taxPrice":null,"brand":null}]}. Use null for unknown fields.\n\nDocument text:\n${text.slice(0, 3000)}`,
          },
        ],
      }),
    });

    if (!res.ok) throw new Error(`LLM error ${res.status}`);

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    const cleaned = content
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
    const parsed = JSON.parse(cleaned);

    return {
      vendor: typeof parsed.vendor === "string" ? parsed.vendor : "unknown",
      orderNumber: typeof parsed.orderNumber === "string" ? parsed.orderNumber : null,
      orderDate: typeof parsed.orderDate === "string" ? parsed.orderDate : null,
      technicianName: typeof parsed.technicianName === "string" ? parsed.technicianName : null,
      trackingNumber: typeof parsed.trackingNumber === "string" ? parsed.trackingNumber : null,
      deliveryCourier: typeof parsed.deliveryCourier === "string" ? parsed.deliveryCourier : null,
      items: Array.isArray(parsed.items)
        ? parsed.items.map((item: Record<string, unknown>) => ({
            partNumber: typeof item.partNumber === "string" ? item.partNumber : "",
            partName: typeof item.partName === "string" ? item.partName : "",
            quantity: typeof item.quantity === "number" ? item.quantity : 1,
            unitPrice: typeof item.unitPrice === "number" ? item.unitPrice : null,
            shipCost: typeof item.shipCost === "number" ? item.shipCost : null,
            taxPrice: typeof item.taxPrice === "number" ? item.taxPrice : null,
            brand: typeof item.brand === "string" ? item.brand : null,
          }))
        : [],
      rawText: text,
    };
  } catch {
    return empty;
  }
}

// --- Unknown PDF Preset Lookup ---

async function tryUnknownPdfPresets(text: string): Promise<DocumentResult | null> {
  const db = getDb();
  const rows = await db.select().from(vendorPresets)
    .where(sql`${vendorPresets.inputType} = 'pdf' AND ${vendorPresets.vendorKey} LIKE 'unknown:%'`);

  for (const row of rows) {
    try {
      const config = JSON.parse(row.selectors) as PdfRegexConfig;
      if (!config.vendorDetectPattern) continue;
      if (!new RegExp(config.vendorDetectPattern, "i").test(text)) continue;

      const result = applyPdfRegexConfig(text, config);
      if (validateExtractionResult(result).valid) {
        await recordPresetSuccess(row.id);
        return result;
      }
      await recordPresetFailure(row.id);
    } catch { /* skip malformed */ }
  }
  return null;
}

function applyPdfRegexConfig(text: string, config: PdfRegexConfig): DocumentResult {
  const items: ExtractedItem[] = [];
  if (config.itemLinePattern) {
    const re = new RegExp(config.itemLinePattern, "gm");
    let m;
    while ((m = re.exec(text)) !== null) {
      const line = m[0];
      const pn = config.fields.partNumber ? (line.match(new RegExp(config.fields.partNumber))?.[1] ?? "") : "";
      const name = config.fields.partName ? (line.match(new RegExp(config.fields.partName))?.[1] ?? "") : "";
      const qty = config.fields.quantity ? (parseInt(line.match(new RegExp(config.fields.quantity))?.[1] ?? "1") || 1) : 1;
      const price = config.fields.unitPrice ? (parseFloat(line.match(new RegExp(config.fields.unitPrice))?.[1] ?? "") || null) : null;
      if (pn || name) items.push({ partNumber: pn, partName: name, quantity: qty, unitPrice: price, shipCost: null, taxPrice: null, brand: findBrand(name) ?? null });
    }
  }
  return {
    vendor: "unknown",
    orderNumber: config.orderFields?.orderNumber ? (text.match(new RegExp(config.orderFields.orderNumber))?.[1] ?? null) : null,
    orderDate: config.orderFields?.orderDate ? (text.match(new RegExp(config.orderFields.orderDate))?.[1] ?? null) : null,
    technicianName: null, trackingNumber: null, deliveryCourier: null, items, rawText: text,
  };
}

// --- PDF Preset Learning ---

async function learnPdfPreset(text: string, llmResult: DocumentResult): Promise<void> {
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey) return;

  const res = await fetch(ZAI_CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "glm-4-flash-250414", temperature: 0, max_tokens: 1500,
      messages: [
        { role: "system", content: "You generate regex patterns for extracting order data from document text. Reply ONLY with valid JSON." },
        { role: "user", content: `Given this document text, generate regex patterns. Reply with JSON:\n{"vendorDetectPattern":"regex to identify this vendor","itemLinePattern":"regex matching each item line","fields":{"partNumber":"regex with capture group","partName":"regex with capture group","quantity":"regex with capture group","unitPrice":"regex with capture group"},"orderFields":{"orderNumber":"regex with capture group or null","orderDate":"regex with capture group or null"}}\n\nDocument:\n${text.slice(0, 3000)}` },
      ],
    }),
  });
  if (!res.ok) return;

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = data.choices?.[0]?.message?.content ?? "";
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

  let config: PdfRegexConfig;
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed.vendorDetectPattern || !parsed.itemLinePattern) return;
    config = { type: "pdf", ...parsed };
  } catch { return; }

  // Verification replay
  const replay = applyPdfRegexConfig(text, config);
  if (!validateExtractionResult(replay).valid) return;
  const minItems = Math.min(replay.items.length, llmResult.items.length);
  if (Math.abs(replay.items.length - llmResult.items.length) > 1 || minItems === 0) return;

  let nameMatches = 0;
  for (let i = 0; i < minItems; i++) {
    const a = replay.items[i].partName.toLowerCase().trim();
    const b = llmResult.items[i].partName.toLowerCase().trim();
    if (a === b || (a.length > 0 && b.includes(a.slice(0, Math.floor(a.length * 0.7))))) nameMatches++;
  }
  if (nameMatches / minItems < 0.7) return;

  const fp = computePdfFingerprint(text);
  const vk = "unknown:" + crypto.createHash("sha256").update(config.vendorDetectPattern).digest("hex").slice(0, 12);
  await savePreset(vk, "pdf", fp, config, text.slice(0, 2000));
}

// --- Main Entry ---

export async function parseDocument(pdfBase64: string): Promise<DocumentResult> {
  const buffer = Buffer.from(pdfBase64, "base64");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  await parser.destroy();
  const text = result.text.replace(/\f/g, "\n").trim();
  if (text.length < 20) throw new Error("Document appears to be empty or image-only");

  // Stage 1: Hardcoded parsers with validation gate
  if (/amazon\.com/i.test(text)) { const r = parseAmazon(text); if (validateExtractionResult(r).valid) return r; }
  if (/ebay/i.test(text) && /order number/i.test(text)) { const r = parseEbay(text); if (validateExtractionResult(r).valid) return r; }
  if (/marcone/i.test(text)) { const r = parseMarcone(text); if (validateExtractionResult(r).valid) return r; }

  // Stage 2: Saved presets for unknown PDF vendors
  const presetResult = await tryUnknownPdfPresets(text);
  if (presetResult) return presetResult;

  // Stage 3: LLM fallback + fire-and-forget preset learning
  const llmResult = await parseFallback(text);
  if (validateExtractionResult(llmResult).valid && llmResult.items.length > 0) {
    learnPdfPreset(text, llmResult).catch((e) => console.error("PDF preset learning failed:", e));
  }
  return llmResult;
}
