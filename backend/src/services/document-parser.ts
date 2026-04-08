import { PDFParse } from "pdf-parse";

export interface ExtractedItem {
  partNumber: string;
  description: string;
  quantity: number;
  unitPrice: number | null;
  brand: string | null;
}

export interface DocumentResult {
  vendor: string;
  orderNumber: string | null;
  orderDate: string | null;
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

function findPartNumbers(text: string): string[] {
  // Collect all matches with their position in the text
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
  // Return in text position order so the first-mentioned part number comes first
  return matches.sort((a, b) => a.index - b.index).map((m) => m.pn);
}

function findBrand(text: string): string | null {
  const m = BRAND_PATTERN.exec(text);
  return m ? m[1].toLowerCase() : null;
}

// --- Amazon Template ---
// pdf-parse v2 output format:
//   1 of: <description>\n<continuation>\nSold by...\nCondition: New\n$<price>\n...

function parseAmazon(text: string): DocumentResult {
  const orderMatch = text.match(/Order\s*#?\s*(\d{3}-\d{7}-\d{7})/);
  const dateMatch = text.match(/Order Placed:\s*(.+)/);

  const items: ExtractedItem[] = [];

  // Split items by "N of:" pattern
  const segments = text.split(/(\d+)\s+of:\s*/);

  for (let i = 1; i < segments.length - 1; i += 2) {
    const quantity = parseInt(segments[i]);
    const block = segments[i + 1];

    // Description is first line
    const descLine = block.split("\n")[0].trim();

    // Search the whole block for part numbers and brand (description may wrap)
    const partNumbers = findPartNumbers(block);
    const brand = findBrand(block);

    // Price appears after "Condition: New\n$X.XX" or as standalone "$X.XX" line
    const conditionPrice = block.match(/Condition:\s*\w+\n\$(\d+\.?\d*)/);
    let price: number | null = null;
    if (conditionPrice) {
      price = parseFloat(conditionPrice[1]);
    } else {
      // Fallback: first standalone dollar amount
      const standalone = block.match(/^\$(\d+\.?\d*)\s*$/m);
      if (standalone) price = parseFloat(standalone[1]);
    }

    items.push({
      partNumber: partNumbers[0] ?? "",
      description: descLine.slice(0, 200),
      quantity,
      unitPrice: price,
      brand,
    });
  }

  return {
    vendor: "amazon",
    orderNumber: orderMatch?.[1] ?? null,
    orderDate: dateMatch?.[1]?.trim() ?? null,
    items,
    rawText: text,
  };
}

// --- eBay Template ---
// pdf-parse v2 output format (tab-separated, compact):
//   Quantity \tItem name Shipping\nservice\nItem\nprice
//   1 Item Name\n(ebayId) Shipping Method \t$10.99

function parseEbay(text: string): DocumentResult {
  const orderMatch = text.match(/Order number:\s*(\S+)/);
  const dateMatch = text.match(/Placed on\s*[\t\n]\s*(.+)/);

  const items: ExtractedItem[] = [];

  // Clean page markers first
  const cleaned = text
    .replace(/Page \d+ of \d+\tabout:srcdoc/g, "")
    .replace(/-- \d+ of \d+ --/g, "");

  // Items live after "Items bought from" header
  const sections = cleaned.split(/Items bought from/i);

  for (let s = 1; s < sections.length; s++) {
    const section = sections[s];

    // After "Item\nprice" header, find item lines
    const afterHeaders = section.split(/Item\s*\n?price/i)[1];
    if (!afterHeaders) continue;

    // Match lines starting with quantity: "N <item text>...\t$price"
    // The item may span multiple lines until we hit a tab+price
    const lines = afterHeaders.split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      // Line starts with a digit (quantity) followed by space and item name
      const qtyMatch = line.match(/^(\d+)\s+(.+)/);
      if (!qtyMatch) {
        i++;
        continue;
      }

      const qty = parseInt(qtyMatch[1]);
      let itemBlock = qtyMatch[2];

      // Collect continuation lines until we find a price
      let price: number | null = null;
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const priceLine = lines[j];
        const pm = priceLine.match(/\$(\d+\.?\d*)/);
        if (pm) {
          price = parseFloat(pm[1]);
          // Include text before the price
          itemBlock += " " + priceLine.replace(/\$\d+\.?\d*/, "").trim();
          i = j + 1;
          break;
        }
        itemBlock += " " + priceLine.trim();
      }
      if (price === null) {
        // Check if price is on same line (tab-separated)
        const inlinePrice = itemBlock.match(/\t\$(\d+\.?\d*)/);
        if (inlinePrice) {
          price = parseFloat(inlinePrice[1]);
          itemBlock = itemBlock.replace(/\t\$\d+\.?\d*/, "");
        }
        i++;
      }

      // Clean up: remove eBay item ID, shipping method noise
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
          description: cleanName.slice(0, 200),
          quantity: qty,
          unitPrice: price,
          brand,
        });
      }
    }
  }

  return {
    vendor: "ebay",
    orderNumber: orderMatch?.[1] ?? null,
    orderDate: dateMatch?.[1]?.trim() ?? null,
    items,
    rawText: text,
  };
}

// --- Marcone Template ---
// pdf-parse v2 output format (tab-separated table):
//   Ord \tPart \tMake \tDescription \tNARDA # \tUnit Price \tMSRP\nPrice\nTotal\tB/O\tShip
//   1 \tWR78X20987 \tDOOR GASKET \t$88.83 \t$157.28 \t$88.83\t1 \t0

function parseMarcone(text: string): DocumentResult {
  const invoiceMatch = text.match(/Invoice:\s*(\d+)/);
  const dateMatch = text.match(/Invoice Date:\s*(.+)/);

  const items: ExtractedItem[] = [];

  // Find data rows: lines starting with a digit, tab-separated, containing a dollar amount
  const lines = text.split("\n");
  for (const line of lines) {
    // Data rows: "1 \tWR78X20987 \tDOOR GASKET \t$88.83 ..."
    if (!/^\d+\s*\t/.test(line)) continue;
    if (!/\$/.test(line)) continue;

    const cols = line.split("\t").map((c) => c.trim());
    // cols[0] = qty (Ord), cols[1] = part number, cols[2] = description (or make+desc)
    const quantity = parseInt(cols[0]) || 1;

    // Find part number in the columns
    let partNumber = "";
    let description = "";
    const prices: number[] = [];

    for (const col of cols.slice(1)) {
      // Check if it's a price
      const priceMatch = col.match(/^\$(\d+\.?\d*)/);
      if (priceMatch) {
        prices.push(parseFloat(priceMatch[1]));
        continue;
      }
      // Check if it looks like a part number
      const pns = findPartNumbers(col);
      if (pns.length > 0 && !partNumber) {
        partNumber = pns[0];
        continue;
      }
      // Check if it's a pure number (B/O or Ship column)
      if (/^\d+$/.test(col)) continue;
      // Otherwise it's likely description
      if (col && !description) {
        description = col;
      }
    }

    // First price is unit price
    const unitPrice = prices[0] ?? null;

    if (partNumber || description) {
      items.push({
        partNumber,
        description,
        quantity,
        unitPrice,
        brand: null,
      });
    }
  }

  // If table parsing found nothing, fall back to regex extraction from full text
  if (items.length === 0) {
    const partNumbers = findPartNumbers(text);
    const descMatch = text.match(
      /Description[\s\S]*?\t([A-Z][A-Z\s/\-,.]+)/
    );
    const description = descMatch?.[1]?.trim() ?? "";
    const priceMatch = text.match(/\$(\d+\.?\d{2})/);
    const unitPrice = priceMatch ? parseFloat(priceMatch[1]) : null;

    for (const pn of partNumbers) {
      items.push({
        partNumber: pn,
        description,
        quantity: 1,
        unitPrice,
        brand: null,
      });
    }
  }

  return {
    vendor: "marcone",
    orderNumber: invoiceMatch?.[1] ?? null,
    orderDate: dateMatch?.[1]?.trim() ?? null,
    items,
    rawText: text,
  };
}

// --- LLM Fallback ---

const ZAI_CHAT_URL = "https://api.z.ai/api/paas/v4/chat/completions";

async function parseFallback(text: string): Promise<DocumentResult> {
  const apiKey = process.env.ZAI_API_KEY;

  if (!apiKey) {
    const partNumbers = findPartNumbers(text);
    return {
      vendor: "unknown",
      orderNumber: null,
      orderDate: null,
      items: partNumbers.map((pn) => ({
        partNumber: pn,
        description: "",
        quantity: 1,
        unitPrice: null,
        brand: null,
      })),
      rawText: text,
    };
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
        max_tokens: 1000,
        messages: [
          {
            role: "system",
            content:
              "You extract purchase order line items from document text. Reply ONLY with valid JSON, no markdown.",
          },
          {
            role: "user",
            content: `Extract all purchased items from this document. Reply with JSON: {"vendor": "...", "orderNumber": "...", "orderDate": "...", "items": [{"partNumber": "...", "description": "...", "quantity": 1, "unitPrice": null, "brand": null}]}. Use null for unknown fields. partNumber should be an appliance part number if visible.\n\nDocument text:\n${text.slice(0, 3000)}`,
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
      orderNumber:
        typeof parsed.orderNumber === "string" ? parsed.orderNumber : null,
      orderDate:
        typeof parsed.orderDate === "string" ? parsed.orderDate : null,
      items: Array.isArray(parsed.items)
        ? parsed.items.map((item: Record<string, unknown>) => ({
            partNumber:
              typeof item.partNumber === "string" ? item.partNumber : "",
            description:
              typeof item.description === "string" ? item.description : "",
            quantity: typeof item.quantity === "number" ? item.quantity : 1,
            unitPrice:
              typeof item.unitPrice === "number" ? item.unitPrice : null,
            brand: typeof item.brand === "string" ? item.brand : null,
          }))
        : [],
      rawText: text,
    };
  } catch {
    const partNumbers = findPartNumbers(text);
    return {
      vendor: "unknown",
      orderNumber: null,
      orderDate: null,
      items: partNumbers.map((pn) => ({
        partNumber: pn,
        description: "",
        quantity: 1,
        unitPrice: null,
        brand: null,
      })),
      rawText: text,
    };
  }
}

// --- Main Entry ---

export async function parseDocument(
  pdfBase64: string
): Promise<DocumentResult> {
  const buffer = Buffer.from(pdfBase64, "base64");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  await parser.destroy();

  // Clean text: remove form feeds, collapse excessive whitespace
  const text = result.text.replace(/\f/g, "\n").trim();

  if (text.length < 20) {
    throw new Error("Document appears to be empty or image-only");
  }

  // Detect vendor and use template
  if (/amazon\.com/i.test(text)) return parseAmazon(text);
  if (/ebay/i.test(text) && /order number/i.test(text)) return parseEbay(text);
  if (/marcone/i.test(text)) return parseMarcone(text);

  // Unknown vendor
  return parseFallback(text);
}
