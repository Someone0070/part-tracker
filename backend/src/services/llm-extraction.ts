import { redactForLlm, scrubHtmlForSelectors, parseHtmlWithSelectors } from "./html-parser.js";
import { validateExtractionResult, savePreset } from "./vendor-presets.js";
import type { DocumentResult } from "./document-parser.js";
import type { HtmlSelectorConfig } from "./vendor-presets.js";

const ZAI_CHAT_URL = "https://api.z.ai/api/paas/v4/chat/completions";
const MODEL = "glm-4-flash-250414";

async function callLlm(systemPrompt: string, userPrompt: string): Promise<string | null> {
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(ZAI_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 2000,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    return content
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
  } catch {
    return null;
  }
}

// --- Step 1: LLM item extraction ---

export async function extractItemsViaLlm(html: string, vendorName: string): Promise<DocumentResult | null> {
  const text = redactForLlm(html);

  const raw = await callLlm(
    "You extract purchase order line items from document text. Reply ONLY with valid JSON, no markdown.",
    `Extract all purchased items from this document. Reply with JSON: {"vendor":"...","orderNumber":"...","orderDate":"...","technicianName":null,"trackingNumber":null,"deliveryCourier":null,"items":[{"partNumber":"...","partName":"...","quantity":1,"unitPrice":null,"shipCost":null,"taxPrice":null,"brand":null}]}. Use null for unknown fields.\n\nDocument text:\n${text}`
  );

  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return {
      vendor: typeof parsed.vendor === "string" ? parsed.vendor : vendorName,
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
  const scrubbed = scrubHtmlForSelectors(html);
  const raw = await callLlm(SELECTOR_SYSTEM_PROMPT, SELECTOR_USER_PROMPT + scrubbed);
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
