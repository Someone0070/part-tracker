import OpenAI from "openai";
import type { ExtractionRules } from "./template-types.js";

interface LlmExtractionItem {
  partNumber: string;
  partName: string;
  quantity: number;
  unitPrice: number | null;
  brand: string | null;
}

export interface LlmExtraction {
  vendor: string;
  orderNumber: string | null;
  orderDate: string | null;
  technicianName: string | null;
  trackingNumber: string | null;
  deliveryCourier: string | null;
  totalTax: number | null;
  totalShipping: number | null;
  items: LlmExtractionItem[];
}

// --- Models ---

export const EXTRACTION_MODEL = "gpt-5.4-nano";
export const TEMPLATE_MODEL = "gpt-5.4-mini";
export const ESCALATION_MODEL = "gemini-2.5-flash";

let _openaiClient: OpenAI | null = null;
let _geminiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!_openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    _openaiClient = new OpenAI({ apiKey });
  }
  return _openaiClient;
}

function getGeminiClient(): OpenAI {
  if (!_geminiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    _geminiClient = new OpenAI({
      apiKey,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    });
  }
  return _geminiClient;
}

function getClientForModel(model: string): OpenAI {
  if (model.startsWith("gemini")) return getGeminiClient();
  return getOpenAIClient();
}

export function isLlmConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

export function isEscalationConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

// --- Schemas ---

const EXTRACTION_SCHEMA = {
  name: "invoice_extraction",
  strict: true,
  schema: {
    type: "object",
    properties: {
      vendor: { type: "string" },
      orderNumber: { type: ["string", "null"] },
      orderDate: { type: ["string", "null"] },
      technicianName: { type: ["string", "null"] },
      trackingNumber: { type: ["string", "null"] },
      deliveryCourier: { type: ["string", "null"] },
      totalTax: { type: ["number", "null"] },
      totalShipping: { type: ["number", "null"] },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            partNumber: { type: "string" },
            partName: { type: "string" },
            quantity: { type: "number" },
            unitPrice: { type: ["number", "null"] },
            brand: { type: ["string", "null"] },
          },
          required: ["partNumber", "partName", "quantity", "unitPrice", "brand"],
          additionalProperties: false,
        },
      },
    },
    required: ["vendor", "orderNumber", "orderDate", "technicianName", "trackingNumber", "deliveryCourier", "totalTax", "totalShipping", "items"],
    additionalProperties: false,
  },
};

const TEMPLATE_SCHEMA = {
  name: "invoice_template",
  strict: true,
  schema: {
    type: "object",
    properties: {
      vendorName: { type: "string" },
      vendorSignals: {
        type: "object",
        properties: {
          domains: { type: "array", items: { type: "string" } },
          keywords: { type: "array", items: { type: "string" } },
        },
        required: ["domains", "keywords"],
        additionalProperties: false,
      },
      lineItems: {
        type: "object",
        properties: {
          start: { type: "string" },
          end: { type: "string" },
          row: { type: "string" },
        },
        required: ["start", "end", "row"],
        additionalProperties: false,
      },
    },
    required: ["vendorName", "vendorSignals", "lineItems"],
    additionalProperties: false,
  },
};

const REPAIR_SCHEMA = {
  name: "regex_repairs",
  strict: true,
  schema: {
    type: "object",
    properties: {
      repairs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            regex: { type: "string" },
          },
          required: ["name", "regex"],
          additionalProperties: false,
        },
      },
    },
    required: ["repairs"],
    additionalProperties: false,
  },
};

const FILL_IN_SCHEMA = {
  name: "invoice_fill_in",
  strict: true,
  schema: {
    type: "object",
    properties: {
      orderNumber: { type: ["string", "null"] },
      orderDate: { type: ["string", "null"] },
      technicianName: { type: ["string", "null"] },
      trackingNumber: { type: ["string", "null"] },
      deliveryCourier: { type: ["string", "null"] },
      totalTax: { type: ["number", "null"] },
      totalShipping: { type: ["number", "null"] },
    },
    required: ["orderNumber", "orderDate", "technicianName", "trackingNumber", "deliveryCourier", "totalTax", "totalShipping"],
    additionalProperties: false,
  },
};

// --- Prompts ---

const EXTRACTION_SYSTEM_PROMPT = `You extract purchase order data from document text. Extract ALL line items, order metadata, and totals. Reply with structured JSON.

- vendor is the PLATFORM or STORE name (e.g. "Amazon", "eBay", "Encompass", "WCP"), NOT the individual seller/merchant
- ALWAYS extract totalTax and totalShipping. Look for tax/shipping amounts even in unusual formats (stacked labels then values, summary tables, etc.)
- For totalShipping, account for shipping discounts/credits (e.g. "Shipping: $2.99" + "Free Shipping: -$2.99" = totalShipping 0)
- For quantity, look carefully at the document -- some formats put quantity in unexpected columns. "1 of:" means quantity 1
- unitPrice is the per-unit price, NOT the line total (line total = unitPrice * quantity)
- technicianName is the SHIPPING RECIPIENT (the person the package is shipped to). Look for the name under "Ship to", "Shipping address", "Deliver to", "Recipient". This is NOT the buyer username or account name -- it's the physical person receiving the package.
- For Amazon invoices, items start with "N of:" where N is the quantity. Extract the product name after "of:"
- partNumber should be an actual product/part identifier, NOT an order number`;

const TEMPLATE_SYSTEM_PROMPT = `You generate reusable regex patterns to extract LINE ITEMS from invoices. You only need to handle item rows -- metadata (order number, dates, tracking, totals) is handled separately.

CRITICAL rules:
- All regex patterns MUST use RE2-compatible syntax (NO lookaheads, lookbehinds, or backreferences)
- Row pattern MUST use named capture groups: (?<partNumber>...), (?<description>...), (?<quantity>...), (?<unitPrice>...)
- Row pattern must match ANY item row, not just the ones in this document
- NEVER hardcode literal values from this invoice into regex patterns
- Use \\s+ instead of literal spaces for flexible whitespace matching
- lineItems.start should match the TABLE HEADER row (column labels)
- lineItems.end should match text AFTER the last item row (subtotal, total, payment, etc.)
- Do NOT match payment lines, subtotal lines, or footer text with the row pattern
- For vendor signals, extract the company domain and a unique identifying phrase

Study the document text carefully. Pay attention to tab characters, column ordering, and line structure.`;

// --- API functions ---

// Models that only support temperature=1
const TEMP_FIXED_MODELS = new Set(["gpt-5-nano", "gpt-5-mini"]);

export async function llmExtract(
  text: string,
  abortSignal?: AbortSignal,
  modelOverride?: string
): Promise<LlmExtraction> {
  const model = modelOverride === "gpt-5.4-nano-batch" ? EXTRACTION_MODEL : (modelOverride ?? EXTRACTION_MODEL);
  const client = getOpenAIClient();
  const start = Date.now();
  console.log(`[LLM] extraction starting (${model}, ${text.length} chars)`);

  const response = await client.chat.completions.create(
    {
      model,
      ...(TEMP_FIXED_MODELS.has(model) ? {} : { temperature: 0 }),
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Extract all purchased items from this invoice.\n\nDocument text:\n${text}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: EXTRACTION_SCHEMA as any,
      },
    },
    { signal: abortSignal }
  );

  const content = response.choices[0]?.message?.content;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (!content) {
    console.log(`[LLM] extraction EMPTY response (${elapsed}s)`);
    throw new Error("Empty LLM response");
  }

  const parsed = JSON.parse(content) as LlmExtraction;
  console.log(`[LLM] extraction done (${elapsed}s) -- ${parsed.items.length} items, vendor=${parsed.vendor}`);
  return parsed;
}

const LAYOUT_HINTS: Record<string, string> = {
  "tab-delimited": `LAYOUT TYPE: Tab-delimited columns.
- Items are on SINGLE LINES with TAB characters between fields
- Split on \\t to identify columns. Use [^\\t]+ to match each column
- The row regex should match one tab-separated line per item`,

  "n-of": `LAYOUT TYPE: "N of:" multi-line blocks (Amazon-style).
- Each item starts with a QUANTITY followed by "of:" -- this is the anchor
- The description follows "of:" and may wrap across multiple lines
- "Sold by" or "Condition:" marks the end of the description
- The price appears as "$X.XX" on its own line after the seller/condition lines
- lineItems.start should match "Items Ordered" header
- lineItems.end should match "Shipping Address:" or "Item(s) Subtotal:"
- The row regex MUST use [\\s\\S]*? (not .*) to match across line breaks
- Pattern structure: (?<quantity>\\d+)\\s+of:\\s+(?<description>[\\s\\S]*?)(?:Sold by|Condition:)[\\s\\S]*?\\$(?<unitPrice>[\\d.]+)
- RE2 supports lazy quantifiers (*?) -- use them to avoid overmatching`,

  "space-aligned": `LAYOUT TYPE: Space-aligned columns (table with header row).
- There is a header row with column names (Quantity, Item name, Shipping service, Item price, etc.)
- lineItems.start should match the header row
- lineItems.end should match text after the items (totals, payment info, page footer)
- Items may wrap across 2 lines: line 1 has quantity + description, line 2 has item ID + shipping + price
- If a TAB character appears before the price, use \\t to match it
- Use [\\s\\S]*? to match across line breaks within a single item
- Pattern structure for wrapped items: (?<quantity>\\d+)\\s+(?<description>[^\\n]+)\\n[^\\n]*\\t\\$?(?<unitPrice>[\\d.]+)
- NEVER include vendor-specific text like "eBay Economy" in the regex -- use generic patterns like [^\\t]+ instead`,

  "labeled": `LAYOUT TYPE: Labeled sections with key-value pairs.
- Fields appear as "Label: Value" or "Label\\tValue"
- Items may be in a table section with clear column headers
- Look for section separators (dashes, blank lines, "Items:" headers)`,
};

export async function llmGenerateTemplate(
  text: string,
  extraction: LlmExtraction,
  abortSignal?: AbortSignal,
  modelOverride?: string,
  columnHint?: string,
  layoutType?: string
): Promise<ExtractionRules> {
  const model = modelOverride ?? TEMPLATE_MODEL;
  const client = getClientForModel(model);
  const start = Date.now();
  console.log(`[LLM] template generation starting (${model}, layout=${layoutType ?? "unknown"})`);

  const itemsSummary = JSON.stringify(
    extraction.items.map((i) => ({
      partNumber: i.partNumber,
      partName: i.partName,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
    }))
  );

  const layoutHint = layoutType && LAYOUT_HINTS[layoutType] ? `\n\n${LAYOUT_HINTS[layoutType]}` : "";

  const response = await client.chat.completions.create(
    {
      model,
      temperature: 0,
      messages: [
        { role: "system", content: TEMPLATE_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Generate regex patterns to extract line items from this invoice format.\n\nItems found (for reference -- do NOT hardcode these values):\n${itemsSummary}${layoutHint}${columnHint ? `\n\nIMPORTANT -- Column layout analysis of item lines:\n${columnHint}` : ""}\n\nRaw document text:\n${text}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: TEMPLATE_SCHEMA as any,
      },
    },
    { signal: abortSignal }
  );

  const content = response.choices[0]?.message?.content;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (!content) {
    console.log(`[LLM] template generation EMPTY response (${elapsed}s)`);
    throw new Error("Empty template generation response");
  }

  const parsed = JSON.parse(content);
  // Ensure the result conforms to ExtractionRules (add empty fields/totals)
  const rules: ExtractionRules = {
    vendorName: parsed.vendorName,
    vendorSignals: parsed.vendorSignals,
    fields: [],
    lineItems: parsed.lineItems,
    totals: [],
  };
  console.log(`[LLM] template generation done (${elapsed}s) -- vendor=${rules.vendorName}`);
  return rules;
}

export async function llmRepairRowRegex(
  failure: { expected: string; got: string; context: string },
  abortSignal?: AbortSignal
): Promise<string | null> {
  const client = getOpenAIClient();
  const start = Date.now();
  console.log(`[LLM] row regex repair starting (${TEMPLATE_MODEL})`);

  const response = await client.chat.completions.create(
    {
      model: TEMPLATE_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: `You fix a regex pattern that failed to extract line items from an invoice. Write an RE2-compatible regex (no lookaheads/lookbehinds). The regex MUST use named capture groups: (?<partNumber>...), (?<description>...), (?<quantity>...), (?<unitPrice>...). Study the exact text carefully -- pay attention to tabs and column structure.` },
        { role: "user", content: `The row regex failed.\n\nExpected: ${failure.expected}\nGot: ${failure.got}\n\nContext:\n${failure.context}\n\nReturn the fixed row regex.` },
      ],
      response_format: {
        type: "json_schema",
        json_schema: REPAIR_SCHEMA as any,
      },
    },
    { signal: abortSignal }
  );

  const content = response.choices[0]?.message?.content;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (!content) {
    console.log(`[LLM] row regex repair EMPTY response (${elapsed}s)`);
    return null;
  }

  const parsed = JSON.parse(content) as { repairs: Array<{ name: string; regex: string }> };
  const rowRepair = parsed.repairs.find((r) => r.name === "row");
  console.log(`[LLM] row regex repair done (${elapsed}s) -- ${rowRepair ? "got fix" : "no fix"}`);
  return rowRepair?.regex ?? null;
}

export interface TemplateFillIn {
  orderNumber: string | null;
  orderDate: string | null;
  technicianName: string | null;
  trackingNumber: string | null;
  deliveryCourier: string | null;
  totalTax: number | null;
  totalShipping: number | null;
}

export async function llmFillIn(
  text: string,
  abortSignal?: AbortSignal
): Promise<TemplateFillIn> {
  const client = getOpenAIClient();
  const snippet = text.length > 3000 ? text.slice(0, 3000) : text;
  const start = Date.now();
  console.log(`[LLM] fill-in starting (${EXTRACTION_MODEL}, ${snippet.length} chars)`);

  const response = await client.chat.completions.create(
    {
      model: EXTRACTION_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: "Extract order metadata from this invoice: order number, order date, shipping recipient name (the person the package is shipped to -- look under 'Ship to' or 'Shipping address', NOT the buyer username or account name), tracking number, delivery courier (USPS, UPS, FedEx, Amazon/Prime, etc), total tax, and total shipping. For totalShipping, account for shipping discounts/credits (e.g. Shipping $2.99 + Free Shipping -$2.99 = 0). Return null for anything not found." },
        { role: "user", content: snippet },
      ],
      response_format: {
        type: "json_schema",
        json_schema: FILL_IN_SCHEMA as any,
      },
    },
    { signal: abortSignal }
  );

  const content = response.choices[0]?.message?.content;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (!content) {
    console.log(`[LLM] fill-in EMPTY response (${elapsed}s)`);
    return { orderNumber: null, orderDate: null, technicianName: null, trackingNumber: null, deliveryCourier: null, totalTax: null, totalShipping: null };
  }

  const parsed = JSON.parse(content);
  const filled = Object.entries(parsed).filter(([, v]) => v != null).map(([k]) => k);
  console.log(`[LLM] fill-in done (${elapsed}s) -- found: ${filled.join(", ") || "nothing"}`);
  return parsed;
}
