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

// --- Provider routing ---

interface ProviderConfig {
  baseURL: string;
  envKey: string;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  openrouter: { baseURL: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY" },
  glm: { baseURL: "https://open.bigmodel.cn/api/paas/v4", envKey: "GLM_API_KEY" },
};

function getProviderForModel(modelId: string): { provider: string; model: string } {
  if (modelId.startsWith("glm-")) {
    return { provider: "glm", model: modelId };
  }
  // OpenRouter models have a prefix like "qwen/..."
  return { provider: "openrouter", model: modelId };
}

const _clients: Record<string, OpenAI> = {};

function getClient(provider: string): OpenAI {
  if (!_clients[provider]) {
    const config = PROVIDERS[provider];
    if (!config) throw new Error(`Unknown provider: ${provider}`);
    const apiKey = process.env[config.envKey];
    if (!apiKey) throw new Error(`${config.envKey} is not set`);
    _clients[provider] = new OpenAI({ apiKey, baseURL: config.baseURL });
  }
  return _clients[provider];
}

function getClientForModel(modelId: string): { client: OpenAI; model: string } {
  const { provider, model } = getProviderForModel(modelId);
  return { client: getClient(provider), model };
}

// --- Model lists ---

export const EXTRACTION_MODELS = [
  { id: "glm-4.7-flash", label: "GLM 4.7 Flash", description: "Free" },
  { id: "glm-4.5-flash", label: "GLM 4.5 Flash", description: "Free" },
  { id: "glm-4.7", label: "GLM 4.7", description: "$0.60/M in" },
  { id: "glm-4.5-air", label: "GLM 4.5 Air", description: "$0.20/M in" },
  { id: "glm-4.6", label: "GLM 4.6", description: "$0.60/M in" },
  { id: "qwen/qwen3.5-9b", label: "Qwen 3.5 9B", description: "$0.05/M in" },
  { id: "qwen/qwen3.5-flash-02-23", label: "Qwen 3.5 Flash", description: "$0.065/M in" },
] as const;

export const TEMPLATE_MODELS = [
  { id: "glm-4.7-flash", label: "GLM 4.7 Flash", description: "Free" },
  { id: "glm-4.7", label: "GLM 4.7", description: "$0.60/M in" },
  { id: "glm-4.6", label: "GLM 4.6", description: "$0.60/M in" },
  { id: "glm-5", label: "GLM 5", description: "$1.00/M in" },
  { id: "glm-5.1", label: "GLM 5.1", description: "$1.40/M in, best" },
  { id: "qwen/qwen3.5-flash-02-23", label: "Qwen 3.5 Flash", description: "$0.065/M in" },
  { id: "qwen/qwen3.5-35b-a3b", label: "Qwen 3.5 35B", description: "$0.16/M in" },
] as const;

export type ExtractionModelId = string;
export type TemplateModelId = string;

export const DEFAULT_EXTRACTION_MODEL = "glm-4.7-flash";
export const DEFAULT_TEMPLATE_MODEL = "glm-4.7-flash";

/** All valid model IDs for validation */
export const ALL_MODEL_IDS = [
  ...new Set([
    ...EXTRACTION_MODELS.map((m) => m.id),
    ...TEMPLATE_MODELS.map((m) => m.id),
  ]),
];

export function isLlmConfigured(): boolean {
  return !!process.env.OPENROUTER_API_KEY || !!process.env.GLM_API_KEY;
}

// --- Prompts ---

const EXTRACTION_SYSTEM_PROMPT = `You extract purchase order data from document text. Extract ALL line items, order metadata, and totals.

IMPORTANT:
- ALWAYS extract totalTax and totalShipping. Look for tax/shipping amounts even in unusual formats (stacked labels then values, summary tables, etc.)
- For quantity, look carefully at the document -- some formats put quantity in unexpected columns
- unitPrice is the per-unit price, NOT the line total (line total = unitPrice * quantity)

Reply with ONLY a JSON object in this exact format (no other text):
{
  "vendor": "string",
  "orderNumber": "string or null",
  "orderDate": "string or null",
  "technicianName": "string or null",
  "trackingNumber": "string or null",
  "deliveryCourier": "string or null",
  "totalTax": number or null,
  "totalShipping": number or null,
  "items": [
    {
      "partNumber": "string",
      "partName": "string",
      "quantity": number,
      "unitPrice": number or null,
      "brand": "string or null"
    }
  ]
}`;

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

Study the document text carefully. Pay attention to tab characters, column ordering, and line structure. The regex must actually match the text format you see.

Reply with ONLY a JSON object in this exact format (no other text):
{
  "vendorName": "string",
  "vendorSignals": {
    "domains": ["string"],
    "keywords": ["string"]
  },
  "fields": [
    { "name": "string", "regex": "string", "group": number }
  ],
  "lineItems": {
    "start": "regex string",
    "end": "regex string",
    "row": "regex string with named capture groups"
  },
  "totals": [
    { "name": "tax or shipping", "regex": "string" }
  ]
}`;

const REPAIR_SYSTEM_PROMPT = `You fix regex patterns that failed to extract values from invoice text. You are given the expected value, what the regex actually matched, and the surrounding text. Write RE2-compatible regex (no lookaheads/lookbehinds). For "field" type, use a capture group at the specified group index. For "total" type, capture the number in group 1. Study the exact text carefully -- pay attention to tabs, newlines, and column structure.

Reply with ONLY a JSON object in this exact format (no other text):
{
  "repairs": [
    { "name": "string", "type": "field or total", "regex": "string", "group": number }
  ]
}`;

const FILL_IN_SYSTEM_PROMPT = `Extract order metadata from this invoice: order number, order date, technician/recipient name, tracking number, delivery courier, total tax, and total shipping. Return null for anything not found.

Reply with ONLY a JSON object in this exact format (no other text):
{
  "orderNumber": "string or null",
  "orderDate": "string or null",
  "technicianName": "string or null",
  "trackingNumber": "string or null",
  "deliveryCourier": "string or null",
  "totalTax": number or null,
  "totalShipping": number or null
}`;

// --- Helpers ---

/** Parse JSON from LLM response, stripping markdown fences if present */
function parseJson<T>(raw: string): T {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  return JSON.parse(cleaned) as T;
}

// --- API functions ---

export async function llmExtract(
  text: string,
  extractionModel: string,
  abortSignal?: AbortSignal
): Promise<LlmExtraction> {
  const { client, model } = getClientForModel(extractionModel);
  const start = Date.now();
  console.log(`[LLM] extraction starting (${extractionModel}, ${text.length} chars)`);

  const response = await client.chat.completions.create(
    {
      model,
      temperature: 0,
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Extract all purchased items from this invoice.\n\nDocument text:\n${text}`,
        },
      ],
      response_format: { type: "json_object" },
    },
    { signal: abortSignal }
  );

  const content = response.choices?.[0]?.message?.content;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (!content) {
    console.log(`[LLM] extraction EMPTY response (${elapsed}s)`, JSON.stringify(response).slice(0, 500));
    throw new Error("Empty LLM response");
  }

  const parsed = parseJson<LlmExtraction>(content);
  if (!Array.isArray(parsed.items)) parsed.items = [];
  console.log(`[LLM] extraction done (${elapsed}s) -- ${parsed.items.length} items, vendor=${parsed.vendor}`);
  return parsed;
}

export async function llmGenerateTemplate(
  text: string,
  extraction: LlmExtraction,
  templateModel: string,
  abortSignal?: AbortSignal
): Promise<ExtractionRules> {
  const { client, model } = getClientForModel(templateModel);
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
      model,
      temperature: 0,
      messages: [
        { role: "system", content: TEMPLATE_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Generate a reusable regex extraction template for this invoice format.\n\nExtracted data (for reference -- do NOT hardcode these values):\n${extractionSummary}\n\nRaw document text:\n${text}`,
        },
      ],
      response_format: { type: "json_object" },
    },
    { signal: abortSignal }
  );

  const content = response.choices?.[0]?.message?.content;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (!content) {
    console.log(`[LLM] template generation EMPTY response (${elapsed}s)`, JSON.stringify(response).slice(0, 500));
    throw new Error("Empty template generation response");
  }

  const parsed = parseJson<ExtractionRules>(content);
  console.log(`[LLM] template generation done (${elapsed}s) -- vendor=${parsed.vendorName}, ${parsed.fields?.length ?? 0} fields, ${parsed.totals?.length ?? 0} totals`);
  return parsed;
}

interface FieldFailureInput {
  name: string;
  type: "field" | "total";
  expected: string;
  got: string;
  context: string;
}

export async function llmRepairRegex(
  failures: FieldFailureInput[],
  templateModel: string,
  abortSignal?: AbortSignal
): Promise<Array<{ name: string; type: string; regex: string; group: number }>> {
  const { client, model } = getClientForModel(templateModel);
  const start = Date.now();
  const names = failures.map((f) => f.name).join(", ");
  console.log(`[LLM] regex repair starting (${templateModel}) -- fixing: ${names}`);

  const failureDesc = failures.map((f) =>
    `- ${f.type} "${f.name}": expected "${f.expected}", got "${f.got}"\n  Text around value: ${JSON.stringify(f.context)}`
  ).join("\n");

  const response = await client.chat.completions.create(
    {
      model,
      temperature: 0,
      messages: [
        { role: "system", content: REPAIR_SYSTEM_PROMPT },
        { role: "user", content: `These regex patterns failed. Fix each one:\n\n${failureDesc}` },
      ],
      response_format: { type: "json_object" },
    },
    { signal: abortSignal }
  );

  const content = response.choices?.[0]?.message?.content;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (!content) {
    console.log(`[LLM] regex repair EMPTY response (${elapsed}s)`);
    return [];
  }

  const parsed = parseJson<{ repairs: Array<{ name: string; type: string; regex: string; group: number }> }>(content);
  const repairs = Array.isArray(parsed.repairs) ? parsed.repairs : [];
  console.log(`[LLM] regex repair done (${elapsed}s) -- ${repairs.length} repairs`);
  return repairs;
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
  extractionModel: string,
  abortSignal?: AbortSignal
): Promise<TemplateFillIn> {
  const { client, model } = getClientForModel(extractionModel);
  const snippet = text.length > 3000 ? text.slice(0, 3000) : text;
  const start = Date.now();
  console.log(`[LLM] fill-in starting (${extractionModel}, ${snippet.length} chars)`);

  const response = await client.chat.completions.create(
    {
      model,
      temperature: 0,
      messages: [
        { role: "system", content: FILL_IN_SYSTEM_PROMPT },
        { role: "user", content: snippet },
      ],
      response_format: { type: "json_object" },
    },
    { signal: abortSignal }
  );

  const content = response.choices?.[0]?.message?.content;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (!content) {
    console.log(`[LLM] fill-in EMPTY response (${elapsed}s)`);
    return { orderNumber: null, orderDate: null, technicianName: null, trackingNumber: null, deliveryCourier: null, totalTax: null, totalShipping: null };
  }

  const parsed = parseJson<TemplateFillIn>(content);
  const filled = Object.entries(parsed).filter(([, v]) => v != null).map(([k]) => k);
  console.log(`[LLM] fill-in done (${elapsed}s) -- found: ${filled.join(", ") || "nothing"}`);
  return parsed;
}
