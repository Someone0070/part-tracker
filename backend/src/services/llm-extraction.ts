import { redactForLlm, scrubHtmlForSelectors, parseHtmlWithSelectors } from "./html-parser.js";
import { validateExtractionResult, savePreset } from "./vendor-presets.js";
import { distributeAndNormalize } from "./document-parser.js";
import type { DocumentResult, ExtractedItem } from "./document-parser.js";
import type { HtmlSelectorConfig } from "./vendor-presets.js";
import { llmExtract, isLlmConfigured, EXTRACTION_MODEL } from "./template-llm.js";
import OpenAI from "openai";

// --- Step 1: LLM item extraction (uses OpenAI nano, same as PDF path) ---

export async function extractItemsViaLlm(html: string, vendorName: string): Promise<DocumentResult | null> {
  if (!isLlmConfigured()) return null;

  const text = redactForLlm(html);

  try {
    const extraction = await llmExtract(text);

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

    return {
      vendor: extraction.vendor || vendorName,
      orderNumber: extraction.orderNumber,
      orderDate: extraction.orderDate,
      technicianName: extraction.technicianName,
      trackingNumber: extraction.trackingNumber,
      deliveryCourier: extraction.deliveryCourier,
      items,
      rawText: text,
    };
  } catch (err) {
    console.warn("[URL Import] LLM extraction failed:", err);
    return null;
  }
}

// --- Step 2: CSS selector generation ---

const SELECTOR_SYSTEM_PROMPT = `You generate CSS selectors for extracting order data from HTML pages. Reply ONLY with valid JSON, no markdown.`;

const SELECTOR_USER_PROMPT = `Given this HTML snippet from a vendor order page, generate CSS selectors to extract order information.

Reply with JSON matching this exact schema:
{
  "itemContainer": "CSS selector for each item row",
  "fields": {
    "partName": "selector relative to item container for product name",
    "quantity": "selector relative to item container for quantity",
    "unitPrice": "selector relative to item container for price",
    "partNumber": "selector relative to item container for part/item number, or null"
  },
  "orderFields": {
    "orderNumber": "selector for order number, or null",
    "orderDate": "selector for order date, or null",
    "totalShipping": "selector for total shipping cost, or null",
    "totalTax": "selector for total tax, or null"
  }
}

Use null for fields where you cannot determine a reliable selector.
Prefer ID selectors and data attributes over class names.

HTML snippet:
`;

async function generateSelectors(html: string): Promise<HtmlSelectorConfig | null> {
  if (!isLlmConfigured()) return null;
  const scrubbed = scrubHtmlForSelectors(html);

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  let raw: string | null = null;
  try {
    const response = await client.chat.completions.create({
      model: EXTRACTION_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: SELECTOR_SYSTEM_PROMPT },
        { role: "user", content: SELECTOR_USER_PROMPT + scrubbed },
      ],
    });
    raw = response.choices[0]?.message?.content?.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim() ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed.itemContainer || !parsed.fields?.partName) return null;

    return {
      type: "html",
      itemContainer: parsed.itemContainer,
      fields: {
        partName: parsed.fields.partName,
        quantity: parsed.fields.quantity || parsed.fields.partName,
        unitPrice: parsed.fields.unitPrice || parsed.fields.partName,
        partNumber: parsed.fields.partNumber ?? undefined,
      },
      orderFields: {
        orderNumber: parsed.orderFields?.orderNumber ?? undefined,
        orderDate: parsed.orderFields?.orderDate ?? undefined,
        totalShipping: parsed.orderFields?.totalShipping ?? undefined,
        totalTax: parsed.orderFields?.totalTax ?? undefined,
      },
    };
  } catch {
    return null;
  }
}

// --- Step 3: Verification replay ---

function fuzzyMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return true;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return true;
  let matches = 0;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length > nb.length ? na : nb;
  for (const ch of shorter) {
    if (longer.includes(ch)) matches++;
  }
  return matches / maxLen > 0.7;
}

function verifySelectorsAgainstLlm(
  selectorResult: DocumentResult,
  llmResult: DocumentResult
): boolean {
  if (Math.abs(selectorResult.items.length - llmResult.items.length) > 1) return false;
  if (selectorResult.items.length === 0) return false;

  const minItems = Math.min(selectorResult.items.length, llmResult.items.length);
  let nameMatches = 0;
  let priceMatches = 0;
  for (let i = 0; i < minItems; i++) {
    if (fuzzyMatch(selectorResult.items[i].partName, llmResult.items[i].partName)) nameMatches++;
    if (selectorResult.items[i].unitPrice === llmResult.items[i].unitPrice) priceMatches++;
  }

  return nameMatches / minItems >= 0.7 && priceMatches / minItems >= 0.7;
}

// --- Combined: learn selectors from LLM result ---

export async function learnSelectorsFromLlm(
  llmResult: DocumentResult,
  html: string,
  vendorKey: string,
  fingerprint: string
): Promise<void> {
  const config = await generateSelectors(html);
  if (!config) return;

  const selectorResult = parseHtmlWithSelectors(html, config, llmResult.vendor);
  const validation = validateExtractionResult(selectorResult);
  if (!validation.valid) return;

  if (!verifySelectorsAgainstLlm(selectorResult, llmResult)) return;

  const snippet = scrubHtmlForSelectors(html);
  await savePreset(vendorKey, "html", fingerprint, config, snippet);
}
