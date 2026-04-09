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

export interface LlmResult {
  extraction: LlmExtraction;
  template: ExtractionRules;
}

// --- Extraction (nano: fast + cheap) ---

const EXTRACTION_SYSTEM_PROMPT = `You extract purchase order data from document text. Extract ALL line items, order metadata, and totals. Reply with structured JSON.

- ALWAYS extract totalTax and totalShipping. Look for tax/shipping amounts even in unusual formats (stacked labels then values, summary tables, etc.)
- For quantity, look carefully at the document — some formats put quantity in unexpected columns
- unitPrice is the per-unit price, NOT the line total (line total = unitPrice * quantity)`;

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

// --- Template generation (mini: precise regex crafting) ---

const TEMPLATE_SYSTEM_PROMPT = `You generate reusable regex-based extraction templates for invoice formats. You will receive the raw document text and the extracted data. Generate regex patterns that can re-extract the same data from any invoice in the same format.

CRITICAL rules:
- All regex patterns MUST use RE2-compatible syntax (NO lookaheads, lookbehinds, or backreferences)
- Line item row patterns MUST use named capture groups: (?<partNumber>...), (?<description>...), (?<quantity>...), (?<unitPrice>...)
- Row patterns must match ANY number of item rows, not just the ones in this document
- NEVER hardcode literal values from this invoice (part numbers, prices, names) into regex patterns. Use character classes like \\d+, \\S+, [^\\t]+, .+? instead
- Use \\s+ instead of literal spaces for flexible whitespace matching
- Escape special regex characters properly
- lineItems.start should match the TABLE HEADER row (column labels)
- lineItems.end should match text AFTER the last item row (subtotal, total, payment terms, etc.)
- Do NOT match payment lines, subtotal lines, or footer text with the row pattern
- For vendor signals, extract the company domain and a unique identifying phrase
- fields is an array of {name, regex, group} objects. Use names like "orderNumber", "orderDate", "technicianName", "trackingNumber", "courier"
- totals is an array of {name, regex} objects. Use names "tax" and "shipping"

Study the document text carefully. Pay attention to tab characters, column ordering, and line structure. The regex must actually match the text format you see.`;

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
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            regex: { type: "string" },
            group: { type: "number" },
          },
          required: ["name", "regex", "group"],
          additionalProperties: false,
        },
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
      totals: {
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
    required: ["vendorName", "vendorSignals", "fields", "lineItems", "totals"],
    additionalProperties: false,
  },
};

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

export function isLlmConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

export async function llmExtract(
  text: string,
  abortSignal?: AbortSignal
): Promise<LlmExtraction> {
  const client = getClient();

  const response = await client.chat.completions.create(
    {
      model: "gpt-5.4-nano",
      temperature: 0,
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
  if (!content) throw new Error("Empty LLM response");

  return JSON.parse(content) as LlmExtraction;
}

export async function llmGenerateTemplate(
  text: string,
  extraction: LlmExtraction,
  abortSignal?: AbortSignal
): Promise<ExtractionRules> {
  const client = getClient();

  const extractionSummary = JSON.stringify({
    vendor: extraction.vendor,
    orderNumber: extraction.orderNumber,
    items: extraction.items.map((i) => ({
      partNumber: i.partNumber,
      partName: i.partName,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
    })),
    totalTax: extraction.totalTax,
    totalShipping: extraction.totalShipping,
  });

  const response = await client.chat.completions.create(
    {
      model: "gpt-5.4-mini",
      temperature: 0,
      messages: [
        { role: "system", content: TEMPLATE_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Generate a reusable regex extraction template for this invoice format.\n\nExtracted data (for reference — do NOT hardcode these values):\n${extractionSummary}\n\nRaw document text:\n${text}`,
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
  if (!content) throw new Error("Empty template generation response");

  return JSON.parse(content) as ExtractionRules;
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

/**
 * Cheap nano call to fill in fields the template regex couldn't extract.
 * Used when a saved template extracts items but misses metadata/totals.
 */
export async function llmFillIn(
  text: string,
  abortSignal?: AbortSignal
): Promise<TemplateFillIn> {
  const client = getClient();
  // Trim to keep token cost low
  const snippet = text.length > 3000 ? text.slice(0, 3000) : text;

  const response = await client.chat.completions.create(
    {
      model: "gpt-5.4-nano",
      temperature: 0,
      messages: [
        { role: "system", content: "Extract order metadata from this invoice: order number, order date, technician/recipient name, tracking number, delivery courier, total tax, and total shipping. Return null for anything not found." },
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
  if (!content) return { orderNumber: null, orderDate: null, technicianName: null, trackingNumber: null, deliveryCourier: null, totalTax: null, totalShipping: null };

  return JSON.parse(content);
}
