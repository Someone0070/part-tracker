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

// --- Model constants ---

/** Cheap model for extraction + fill-in */
const EXTRACTION_MODEL = "qwen/qwen3.5-9b";

/** Available template generation models (user-selectable) */
export const TEMPLATE_MODELS = [
  { id: "qwen/qwen3.5-flash-02-23", label: "Qwen 3.5 Flash", description: "Faster, cheaper" },
  { id: "qwen/qwen3.5-35b-a3b", label: "Qwen 3.5 35B", description: "Smarter, 4x cost" },
] as const;

export type TemplateModelId = typeof TEMPLATE_MODELS[number]["id"];

export const DEFAULT_TEMPLATE_MODEL: TemplateModelId = "qwen/qwen3.5-flash-02-23";

// --- Extraction (cheap + fast) ---

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

// --- Template generation (smarter model for regex crafting) ---

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
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
    _client = new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
    });
  }
  return _client;
}

export function isLlmConfigured(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

export async function llmExtract(
  text: string,
  abortSignal?: AbortSignal
): Promise<LlmExtraction> {
  const client = getClient();
  const start = Date.now();
  console.log(`[LLM] extraction starting (${EXTRACTION_MODEL}, ${text.length} chars)`);

  const response = await client.chat.completions.create(
    {
      model: EXTRACTION_MODEL,
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
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (!content) {
    console.log(`[LLM] extraction EMPTY response (${elapsed}s)`);
    throw new Error("Empty LLM response");
  }

  const parsed = JSON.parse(content) as LlmExtraction;
  console.log(`[LLM] extraction done (${elapsed}s) -- ${parsed.items.length} items, vendor=${parsed.vendor}`);
  return parsed;
}

export async function llmGenerateTemplate(
  text: string,
  extraction: LlmExtraction,
  templateModel: string,
  abortSignal?: AbortSignal
): Promise<ExtractionRules> {
  const client = getClient();
  const start = Date.now();
  console.log(`[LLM] template generation starting (${templateModel})`);

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
      model: templateModel,
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
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (!content) {
    console.log(`[LLM] template generation EMPTY response (${elapsed}s)`);
    throw new Error("Empty template generation response");
  }

  const parsed = JSON.parse(content) as ExtractionRules;
  console.log(`[LLM] template generation done (${elapsed}s) -- vendor=${parsed.vendorName}, ${parsed.fields.length} fields, ${parsed.totals.length} totals`);
  return parsed;
}

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
            type: { type: "string" },
            regex: { type: "string" },
            group: { type: "number" },
          },
          required: ["name", "type", "regex", "group"],
          additionalProperties: false,
        },
      },
    },
    required: ["repairs"],
    additionalProperties: false,
  },
};

interface FieldFailureInput {
  name: string;
  type: "field" | "total";
  expected: string;
  got: string;
  context: string;
}

/**
 * Ask the template model to fix specific regex patterns that failed validation.
 */
export async function llmRepairRegex(
  failures: FieldFailureInput[],
  templateModel: string,
  abortSignal?: AbortSignal
): Promise<Array<{ name: string; type: string; regex: string; group: number }>> {
  const client = getClient();
  const start = Date.now();
  const names = failures.map((f) => f.name).join(", ");
  console.log(`[LLM] regex repair starting (${templateModel}) -- fixing: ${names}`);

  const failureDesc = failures.map((f) =>
    `- ${f.type} "${f.name}": expected "${f.expected}", got "${f.got}"\n  Text around value: ${JSON.stringify(f.context)}`
  ).join("\n");

  const response = await client.chat.completions.create(
    {
      model: templateModel,
      temperature: 0,
      messages: [
        { role: "system", content: `You fix regex patterns that failed to extract values from invoice text. You are given the expected value, what the regex actually matched, and the surrounding text. Write RE2-compatible regex (no lookaheads/lookbehinds). For "field" type, use a capture group at the specified group index. For "total" type, capture the number in group 1. Study the exact text carefully — pay attention to tabs (\\t), newlines (\\n), and column structure.` },
        { role: "user", content: `These regex patterns failed. Fix each one:\n\n${failureDesc}` },
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
    console.log(`[LLM] regex repair EMPTY response (${elapsed}s)`);
    return [];
  }

  const parsed = JSON.parse(content) as { repairs: Array<{ name: string; type: string; regex: string; group: number }> };
  console.log(`[LLM] regex repair done (${elapsed}s) -- ${parsed.repairs.length} repairs`);
  return parsed.repairs;
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
 * Cheap call to fill in fields the template regex couldn't extract.
 */
export async function llmFillIn(
  text: string,
  abortSignal?: AbortSignal
): Promise<TemplateFillIn> {
  const client = getClient();
  const snippet = text.length > 3000 ? text.slice(0, 3000) : text;
  const start = Date.now();
  console.log(`[LLM] fill-in starting (${EXTRACTION_MODEL}, ${snippet.length} chars)`);

  const response = await client.chat.completions.create(
    {
      model: EXTRACTION_MODEL,
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
