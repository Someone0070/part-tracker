export interface OcrResult {
  modelNumber: string | null;
  serialNumber: string | null;
  brand: string | null;
  rawText: string;
}

const ZAI_OCR_URL = "https://api.z.ai/api/paas/v4/layout_parsing";
const ZAI_CHAT_URL = "https://api.z.ai/api/paas/v4/chat/completions";

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

function tryMatch(patterns: RegExp[], text: string): string | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1]) return m[1];
  }
  return null;
}

function extractViaRegex(
  text: string
): Pick<OcrResult, "modelNumber" | "serialNumber" | "brand"> {
  const modelNumber = tryMatch(MODEL_PATTERNS, text);
  const serialNumber = tryMatch(SERIAL_PATTERNS, text);
  const brandMatch = BRAND_PATTERN.exec(text);
  const brand = brandMatch?.[1]?.toLowerCase() ?? null;
  return { modelNumber, serialNumber, brand };
}

async function extractViaChat(
  rawText: string
): Promise<Pick<OcrResult, "modelNumber" | "serialNumber" | "brand">> {
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey) {
    return { modelNumber: null, serialNumber: null, brand: null };
  }

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
        max_tokens: 200,
        messages: [
          {
            role: "system",
            content:
              "You extract appliance information from OCR text. Reply ONLY with valid JSON, no markdown, no explanation.",
          },
          {
            role: "user",
            content: `Extract the model number, serial number, and brand from this appliance sticker OCR text. Reply with JSON: {"modelNumber": "...", "serialNumber": "...", "brand": "..."} — use null for any field you can't find.\n\nOCR text:\n${rawText}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      return { modelNumber: null, serialNumber: null, brand: null };
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
    };

    return {
      modelNumber: typeof parsed.modelNumber === "string" ? parsed.modelNumber : null,
      serialNumber: typeof parsed.serialNumber === "string" ? parsed.serialNumber : null,
      brand: typeof parsed.brand === "string" ? parsed.brand : null,
    };
  } catch {
    return { modelNumber: null, serialNumber: null, brand: null };
  }
}

export async function extractApplianceInfo(imageBase64: string): Promise<OcrResult> {
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey) {
    throw new Error("not configured");
  }

  const ocrRes = await fetch(ZAI_OCR_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "glm-ocr",
      content: [{ type: "image", image: imageBase64 }],
    }),
  });

  if (!ocrRes.ok) {
    const body = await ocrRes.text().catch(() => "");
    throw new Error(`OCR API error ${ocrRes.status}: ${body}`);
  }

  const ocrData = (await ocrRes.json()) as { content?: string; text?: string };
  const rawText = ocrData.content ?? ocrData.text ?? "";

  let extracted = extractViaRegex(rawText);

  if (!extracted.modelNumber || !extracted.serialNumber) {
    const fallback = await extractViaChat(rawText);
    extracted = {
      modelNumber: extracted.modelNumber ?? fallback.modelNumber,
      serialNumber: extracted.serialNumber ?? fallback.serialNumber,
      brand: extracted.brand ?? fallback.brand,
    };
  }

  return {
    modelNumber: extracted.modelNumber,
    serialNumber: extracted.serialNumber,
    brand: extracted.brand,
    rawText,
  };
}
