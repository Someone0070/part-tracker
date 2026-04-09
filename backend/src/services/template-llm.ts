import OpenAI from "openai";
import type { ExtractionRules } from "./template-types.js";

interface LlmExtractionItem {
  partNumber: string;
  partName: string;
  quantity: number;
  unitPrice: number | null;
  brand: string | null;
}

export interface LlmResult {
  extraction: {
    vendor: string;
    orderNumber: string | null;
    orderDate: string | null;
    technicianName: string | null;
    trackingNumber: string | null;
    deliveryCourier: string | null;
    items: LlmExtractionItem[];
  };
  template: ExtractionRules;
}

const SYSTEM_PROMPT = `You extract purchase order data from document text AND generate a reusable regex-based extraction template for this vendor's invoice format.

CRITICAL rules for the template:
- All regex patterns use RE2-compatible syntax (no lookaheads, lookbehinds, or backreferences)
- Line item row patterns MUST use named capture groups: (?<partNumber>...), (?<description>...), (?<quantity>...), (?<unitPrice>...)
- Row patterns must match ANY number of item rows, not just the ones in this document
- NEVER hardcode literal values from this invoice (part numbers, prices, names) into regex patterns. Use character classes like \\d+, \\S+, [^\\t]+, .+? instead
- Use \\s+ instead of literal spaces for flexible whitespace matching
- Escape special regex characters properly
- lineItems.start should match the TABLE HEADER row (column labels)
- lineItems.end should match text AFTER the last item row (subtotal, total, payment terms, etc.)
- Do NOT match payment lines, subtotal lines, or footer text with the row pattern
- For vendor signals, extract the company domain and a unique identifying phrase`;

const RESPONSE_SCHEMA = {
  name: "invoice_extraction",
  strict: true,
  schema: {
    type: "object",
    properties: {
      extraction: {
        type: "object",
        properties: {
          vendor: { type: "string" },
          orderNumber: { type: ["string", "null"] },
          orderDate: { type: ["string", "null"] },
          technicianName: { type: ["string", "null"] },
          trackingNumber: { type: ["string", "null"] },
          deliveryCourier: { type: ["string", "null"] },
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
        required: ["vendor", "orderNumber", "orderDate", "technicianName", "trackingNumber", "deliveryCourier", "items"],
        additionalProperties: false,
      },
      template: {
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
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                regex: { type: "string" },
                group: { type: "number" },
              },
              required: ["regex", "group"],
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
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
        required: ["vendorName", "vendorSignals", "fields", "lineItems", "totals"],
        additionalProperties: false,
      },
    },
    required: ["extraction", "template"],
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

export async function llmExtractAndLearn(
  text: string,
  abortSignal?: AbortSignal
): Promise<LlmResult> {
  const client = getClient();

  const response = await client.chat.completions.create(
    {
      model: "gpt-5.4-nano",
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Extract all purchased items from this invoice and generate a reusable regex template for this vendor's format.\n\nDocument text:\n${text}`,
        },
      ],
      response_format: {
        type: "json_schema",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        json_schema: RESPONSE_SCHEMA as any,
      },
    },
    { signal: abortSignal }
  );

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty LLM response");

  return JSON.parse(content) as LlmResult;
}
