import type { PreparedImage } from "./image-input.js";
import { imageToDataUri } from "./image-input.js";
import { fetchWithRetry } from "./http-retry.js";

export interface OcrResult {
  modelNumber: string | null;
  serialNumber: string | null;
  brand: string | null;
  applianceType: string | null;
  rawText: string;
}

const ZAI_OCR_URL = "https://api.z.ai/api/paas/v4/layout_parsing";
const ZAI_CHAT_URL = "https://api.z.ai/api/paas/v4/chat/completions";

export class OcrProviderError extends Error {
  constructor(
    public readonly providerStatus: number,
    public readonly providerBody: string,
  ) {
    super(`OCR provider rejected the normalized image (${providerStatus})`);
    this.name = "OcrProviderError";
  }
}

const MODEL_PATTERNS = [
  /model\s*(?:#|no\.?|number)?[\s:]*([A-Z0-9][\w\-.\/]{3,30})/i,
  /mod(?:el)?\.?\s*(?:#|no\.?)?[\s:]*([A-Z0-9][\w\-.\/]{3,30})/i,
  /m\/n[\s:]*([A-Z0-9][\w\-.\/]{3,30})/i,
];

const SERIAL_PATTERNS = [
  /serial\s*(?:#|no\.?|number)?[\s:]*([A-Z0-9][\w\-.\/]{3,30})/i,
  /ser(?:ial)?\.?\s*(?:#|no\.?)?[\s:]*([A-Z0-9][\w\-.\/]{3,30})/i,
  /s\/n[\s:]*([A-Z0-9][\w\-.\/]{3,30})/i,
];

const BRAND_PATTERN =
  /\b(whirlpool|kenmore|ge|samsung|lg|maytag|frigidaire|bosch|kitchenaid|amana|hotpoint|electrolux|haier|hisense|insignia)\b/i;

const TYPE_MAP: Record<string, string> = {
  refrigerator: "refrigerator",
  fridge: "refrigerator",
  freezer: "freezer",
  washer: "washer",
  "washing machine": "washer",
  dryer: "dryer",
  dishwasher: "dishwasher",
  range: "range",
  stove: "range",
  oven: "range",
  cooktop: "range",
  microwave: "microwave",
  "air conditioner": "hvac",
  "heat pump": "hvac",
  furnace: "hvac",
  hvac: "hvac",
};

const TYPE_PATTERN = new RegExp(
  `\\b(${Object.keys(TYPE_MAP).join("|")})\\b`,
  "i"
);

function tryMatch(patterns: RegExp[], text: string): string | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1]) return m[1];
  }
  return null;
}

function extractViaRegex(
  text: string
): Pick<OcrResult, "modelNumber" | "serialNumber" | "brand" | "applianceType"> {
  const modelNumber = tryMatch(MODEL_PATTERNS, text);
  const serialNumber = tryMatch(SERIAL_PATTERNS, text);
  const brandMatch = BRAND_PATTERN.exec(text);
  const brand = brandMatch?.[1]?.toLowerCase() ?? null;
  const typeMatch = TYPE_PATTERN.exec(text);
  const applianceType = typeMatch ? TYPE_MAP[typeMatch[1].toLowerCase()] ?? null : null;
  return { modelNumber, serialNumber, brand, applianceType };
}

async function extractViaChat(
  rawText: string,
  signal?: AbortSignal,
): Promise<Pick<OcrResult, "modelNumber" | "serialNumber" | "brand" | "applianceType">> {
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey) {
    return { modelNumber: null, serialNumber: null, brand: null, applianceType: null };
  }

  try {
    const res = await fetchWithRetry(ZAI_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "glm-4-flash-250414",
        temperature: 0,
        max_tokens: 200,
        messages: [
          {
            role: "system",
            content:
              "You extract appliance information from OCR text. Reply ONLY with valid JSON, no markdown, no explanation.",
          },
          {
            role: "user",
            content: `Extract the model number, serial number, brand, and appliance type from this appliance sticker OCR text. Reply with JSON: {"modelNumber": "...", "serialNumber": "...", "brand": "...", "applianceType": "..."} — use null for any field you can't find. applianceType must be one of: refrigerator, washer, dryer, dishwasher, range, microwave, freezer, hvac, other.\n\nOCR text:\n${rawText}`,
          },
        ],
      }),
    }, { attempts: 1, timeoutMs: 15_000, signal });

    if (!res.ok) {
      return { modelNumber: null, serialNumber: null, brand: null, applianceType: null };
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content ?? "";
    const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned) as {
      modelNumber?: unknown;
      serialNumber?: unknown;
      brand?: unknown;
      applianceType?: unknown;
    };

    const validTypes = new Set(["refrigerator", "washer", "dryer", "dishwasher", "range", "microwave", "freezer", "hvac", "other"]);
    const parsedType = typeof parsed.applianceType === "string" ? parsed.applianceType.toLowerCase() : null;

    return {
      modelNumber: typeof parsed.modelNumber === "string" ? parsed.modelNumber : null,
      serialNumber: typeof parsed.serialNumber === "string" ? parsed.serialNumber : null,
      brand: typeof parsed.brand === "string" ? parsed.brand : null,
      applianceType: parsedType && validTypes.has(parsedType) ? parsedType : null,
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return { modelNumber: null, serialNumber: null, brand: null, applianceType: null };
  }
}

export interface PartOcrResult {
  partNumber: string | null;
  brand: string | null;
  description: string | null;
  rawText: string;
}

const PART_NUMBER_PATTERNS = [
  /part\s*(?:#|no\.?|number)?[\s:]*([A-Z0-9][\w\-.\/]{3,30})/i,
  /p\/n[\s:]*([A-Z0-9][\w\-.\/]{3,30})/i,
  /replacement\s*(?:#|no\.?)?[\s:]*([A-Z0-9][\w\-.\/]{3,30})/i,
  /item\s*(?:#|no\.?)?[\s:]*([A-Z0-9][\w\-.\/]{3,30})/i,
  // Common appliance part number formats: WPW10321304, 285753A, AP6013036, PS11746285
  /\b(WP[A-Z]?\d{6,12})\b/i,
  /\b(AP\d{7,10})\b/i,
  /\b(PS\d{7,11})\b/i,
  /\b(\d{5,8}[A-Z]?)\b/,
];

async function extractPartViaChat(
  rawText: string,
  signal?: AbortSignal,
): Promise<Pick<PartOcrResult, "partNumber" | "brand" | "description">> {
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey) {
    return { partNumber: null, brand: null, description: null };
  }

  try {
    const res = await fetchWithRetry(ZAI_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "glm-4-flash-250414",
        temperature: 0,
        max_tokens: 200,
        messages: [
          {
            role: "system",
            content:
              "You extract appliance part information from OCR text. Reply ONLY with valid JSON, no markdown, no explanation.",
          },
          {
            role: "user",
            content: `Extract the part number, brand, and description from this appliance part label OCR text. The part number is the most important field — it's usually an alphanumeric code like WPW10321304, 285753A, AP6013036, etc. Reply with JSON: {"partNumber": "...", "brand": "...", "description": "..."} — use null for any field you can't find.\n\nOCR text:\n${rawText}`,
          },
        ],
      }),
    }, { attempts: 1, timeoutMs: 15_000, signal });

    if (!res.ok) {
      return { partNumber: null, brand: null, description: null };
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content ?? "";
    const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned) as {
      partNumber?: unknown;
      brand?: unknown;
      description?: unknown;
    };

    return {
      partNumber: typeof parsed.partNumber === "string" ? parsed.partNumber : null,
      brand: typeof parsed.brand === "string" ? parsed.brand?.toLowerCase() : null,
      description: typeof parsed.description === "string" ? parsed.description : null,
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return { partNumber: null, brand: null, description: null };
  }
}

interface OcrPayload {
  content?: string;
  text?: string;
  md_results?: string;
  layout_details?: Array<{ content?: string }> | Array<Array<{ content?: string }>>;
}

function layoutText(details: OcrPayload["layout_details"]): string {
  if (!details) return "";
  return details.flat().map((item) => item.content ?? "").join("\n");
}

async function recognizeImage(image: PreparedImage, signal?: AbortSignal): Promise<string> {
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey) {
    throw new Error("not configured");
  }

  const ocrRes = await fetchWithRetry(ZAI_OCR_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "glm-ocr",
      file: imageToDataUri(image),
    }),
  }, {
    attempts: 2,
    timeoutMs: 25_000,
    signal,
  });

  if (!ocrRes.ok) {
    const body = await ocrRes.text().catch(() => "");
    throw new OcrProviderError(ocrRes.status, body.slice(0, 500));
  }

  const ocrData = (await ocrRes.json()) as OcrPayload;
  return (
    ocrData.md_results ??
    ocrData.content ??
    ocrData.text ??
    layoutText(ocrData.layout_details)
  );
}

export async function extractPartInfo(image: PreparedImage, signal?: AbortSignal): Promise<PartOcrResult> {
  const rawText = await recognizeImage(image, signal);

  // Try regex first
  const partNumber = tryMatch(PART_NUMBER_PATTERNS, rawText);
  const brandMatch = BRAND_PATTERN.exec(rawText);
  const brand = brandMatch?.[1]?.toLowerCase() ?? null;

  // LLM fallback if regex missed the part number
  if (!partNumber) {
    const fallback = await extractPartViaChat(rawText, signal);
    return {
      partNumber: fallback.partNumber,
      brand: brand ?? fallback.brand,
      description: fallback.description,
      rawText,
    };
  }

  return { partNumber, brand, description: null, rawText };
}

export async function extractApplianceInfo(image: PreparedImage, signal?: AbortSignal): Promise<OcrResult> {
  const rawText = await recognizeImage(image, signal);

  let extracted = extractViaRegex(rawText);

  if (!extracted.modelNumber || !extracted.serialNumber || !extracted.applianceType) {
    const fallback = await extractViaChat(rawText, signal);
    extracted = {
      modelNumber: extracted.modelNumber ?? fallback.modelNumber,
      serialNumber: extracted.serialNumber ?? fallback.serialNumber,
      brand: extracted.brand ?? fallback.brand,
      applianceType: extracted.applianceType ?? fallback.applianceType,
    };
  }

  return {
    modelNumber: extracted.modelNumber,
    serialNumber: extracted.serialNumber,
    brand: extracted.brand,
    applianceType: extracted.applianceType,
    rawText,
  };
}
