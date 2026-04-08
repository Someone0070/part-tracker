import { PDFParse } from "pdf-parse";

export interface ExtractedItem {
  partNumber: string;
  partName: string;
  quantity: number;
  unitPrice: number | null;
  shipCost: number | null;
  taxPrice: number | null;
  brand: string | null;
}

export interface DocumentResult {
  vendor: string;
  orderNumber: string | null;
  orderDate: string | null;
  technicianName: string | null;
  trackingNumber: string | null;
  deliveryCourier: string | null;
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
  return matches.sort((a, b) => a.index - b.index).map((m) => m.pn);
}

function findBrand(text: string): string | null {
  const m = BRAND_PATTERN.exec(text);
  return m ? m[1].toLowerCase() : null;
}

function parseDollar(text: string): number | null {
  const m = text.match(/\$(\d+\.?\d*)/);
  return m ? parseFloat(m[1]) : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- Amazon Template ---

function parseAmazon(text: string): DocumentResult {
  const orderMatch = text.match(/Order\s*#?\s*(\d{3}-\d{7}-\d{7})/);
  const dateMatch = text.match(/Order Placed:\s*(.+)/);

  // Technician = shipping address name
  const shipNameMatch = text.match(/Shipping Address:\s*\n([^\n]+)/);
  const technicianName = shipNameMatch?.[1]?.trim() ?? null;

  // Courier from shipping speed
  const speedMatch = text.match(/Shipping Speed:\s*\n([^\n]+)/);
  const deliveryCourier = speedMatch?.[1]?.trim() ?? null;

  // Collect total shipping and tax across all shipments
  const shippingMatches = [...text.matchAll(/Shipping & Handling:\s*\$(\d+\.?\d*)/g)];
  const taxMatches = [...text.matchAll(/Sales Tax:\s*\$(\d+\.?\d*)/g)];
  const totalShipping = shippingMatches.reduce((sum, m) => sum + parseFloat(m[1]), 0);
  const totalTax = taxMatches.reduce((sum, m) => sum + parseFloat(m[1]), 0);

  const items: ExtractedItem[] = [];
  const segments = text.split(/(\d+)\s+of:\s*/);

  for (let i = 1; i < segments.length - 1; i += 2) {
    const quantity = parseInt(segments[i]);
    const block = segments[i + 1];
    const descLine = block.split("\n")[0].trim();
    const partNumbers = findPartNumbers(block);
    const brand = findBrand(block);

    const conditionPrice = block.match(/Condition:\s*\w+\n\$(\d+\.?\d*)/);
    let price: number | null = null;
    if (conditionPrice) {
      price = parseFloat(conditionPrice[1]);
    } else {
      const standalone = block.match(/^\$(\d+\.?\d*)\s*$/m);
      if (standalone) price = parseFloat(standalone[1]);
    }

    items.push({
      partNumber: partNumbers[0] ?? "",
      partName: descLine.slice(0, 200),
      quantity,
      unitPrice: price,
      shipCost: null,
      taxPrice: null,
      brand,
    });
  }

  // Distribute shipping and tax evenly across items
  if (items.length > 0) {
    const perItemShip = round2(totalShipping / items.length);
    const perItemTax = round2(totalTax / items.length);
    for (const item of items) {
      item.shipCost = perItemShip;
      item.taxPrice = perItemTax;
    }
  }

  return {
    vendor: "amazon",
    orderNumber: orderMatch?.[1] ?? null,
    orderDate: dateMatch?.[1]?.trim() ?? null,
    technicianName,
    trackingNumber: null,
    deliveryCourier,
    items,
    rawText: text,
  };
}

// --- eBay Template ---

function parseEbay(text: string): DocumentResult {
  const orderMatch = text.match(/Order number:\s*(\S+)/);
  const dateMatch = text.match(/Placed on\s*[\t\n]\s*(.+)/);

  // Technician = shipping address name
  const shipMatch = text.match(/Shipping address\s*\n([^\n]+)/);
  const technicianName = shipMatch?.[1]?.trim() ?? null;

  // Shipping cost
  const shippingMatch = text.match(/Shipping\s*[\t]\s*(?:Free|\$(\d+\.?\d*))/i);
  const totalShipping = shippingMatch?.[1] ? parseFloat(shippingMatch[1]) : 0;

  // Tax
  const taxMatch = text.match(/Tax\*?\s*[\t]\s*\$(\d+\.?\d*)/);
  const totalTax = taxMatch ? parseFloat(taxMatch[1]) : 0;

  // Courier from shipping service in item lines
  let deliveryCourier: string | null = null;

  const items: ExtractedItem[] = [];

  const cleaned = text
    .replace(/Page \d+ of \d+\tabout:srcdoc/g, "")
    .replace(/-- \d+ of \d+ --/g, "");

  const sections = cleaned.split(/Items bought from/i);

  for (let s = 1; s < sections.length; s++) {
    const section = sections[s];
    const afterHeaders = section.split(/Item\s*\n?price/i)[1];
    if (!afterHeaders) continue;

    const lines = afterHeaders.split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      const qtyMatch = line.match(/^(\d+)\s+(.+)/);
      if (!qtyMatch) { i++; continue; }

      const qty = parseInt(qtyMatch[1]);
      let itemBlock = qtyMatch[2];
      let price: number | null = null;

      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const priceLine = lines[j];
        const pm = priceLine.match(/\$(\d+\.?\d*)/);
        if (pm) {
          price = parseFloat(pm[1]);
          itemBlock += " " + priceLine.replace(/\$\d+\.?\d*/, "").trim();
          i = j + 1;
          break;
        }
        itemBlock += " " + priceLine.trim();
      }
      if (price === null) {
        const inlinePrice = itemBlock.match(/\t\$(\d+\.?\d*)/);
        if (inlinePrice) {
          price = parseFloat(inlinePrice[1]);
          itemBlock = itemBlock.replace(/\t\$\d+\.?\d*/, "");
        }
        i++;
      }

      // Extract courier from shipping method in item text
      const courierMatch = itemBlock.match(/\b(eBay\s+\w+|USPS|UPS|FedEx|DHL)\b/i);
      if (courierMatch && !deliveryCourier) deliveryCourier = courierMatch[0].trim();

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
          partName: cleanName.slice(0, 200),
          quantity: qty,
          unitPrice: price,
          shipCost: null,
          taxPrice: null,
          brand,
        });
      }
    }
  }

  // Distribute shipping and tax
  if (items.length > 0) {
    const perItemShip = round2(totalShipping / items.length);
    const perItemTax = round2(totalTax / items.length);
    for (const item of items) {
      item.shipCost = perItemShip;
      item.taxPrice = perItemTax;
    }
  }

  return {
    vendor: "ebay",
    orderNumber: orderMatch?.[1] ?? null,
    orderDate: dateMatch?.[1]?.trim() ?? null,
    technicianName,
    trackingNumber: null,
    deliveryCourier,
    items,
    rawText: text,
  };
}

// --- Marcone Template ---

function parseMarcone(text: string): DocumentResult {
  const invoiceMatch = text.match(/Invoice:\s*(\d+)/);
  const dateMatch = text.match(/Invoice Date:\s*(.+)/);

  // Technician = Ship To person name (not company)
  // Marcone Ship To section has company address first, then actual recipient
  // Look for a name-like line near the physical shipping address
  const shipToSection = text.split(/Ship To:/i)[1]?.split(/Remit Payment/i)[0] ?? "";
  let technicianName: string | null = null;
  if (shipToSection) {
    const shipLines = shipToSection.split("\n").map((l) => l.trim()).filter(Boolean);
    // Walk backwards - the actual recipient name is usually near the end, before "Remit Payment"
    // It's a short all-alpha line that isn't an address
    for (let i = shipLines.length - 1; i >= 0; i--) {
      const line = shipLines[i];
      if (/^\d/.test(line)) continue; // address line
      if (/,\s*[A-Z]{2}\s+\d{5}/.test(line)) continue; // city, state zip
      if (/\b(LLC|INC|CORP|LTD)\b/i.test(line)) continue; // company
      if (/^UNIT\b/i.test(line)) continue; // unit number
      if (line.length > 2 && line.length < 40 && /^[A-Z\s.'-]+$/i.test(line)) {
        technicianName = line;
        break;
      }
    }
  }

  // Tracking number
  const trackingMatch = text.match(/Tracking\s*#?\s*[\t\s]*(?:\*+\s*[\t\s]*)?(\d{10,})/);
  const trackingNumber = trackingMatch?.[1] ?? null;

  // Shipping (Delivery) and Tax — Marcone stacks labels then values:
  //   SubTotal:\nSales Tax:\nDelivery:\nHandling:\nC.O.D. Fee:\nInvoice Total:\n$88.83\n$8.44\n$13.49\n$0.00\n$0.00\n$110.76
  let totalShipping = 0;
  let totalTax = 0;
  // Grab from SubTotal through the dollar values that follow Invoice Total
  const subSection = text.match(/SubTotal:[\s\S]*?Invoice Total:\s*(?:\n\$[\d.]+)+/);
  if (subSection) {
    const block = subSection[0];
    const labels = [...block.matchAll(/(SubTotal|Sales Tax|Delivery|Handling|C\.O\.D\.\s*Fee|Invoice Total):/gi)]
      .map((m) => m[1].toLowerCase());
    const values = [...block.matchAll(/\$(\d+\.?\d*)/g)].map((m) => parseFloat(m[1]));
    const taxIdx = labels.indexOf("sales tax");
    const deliveryIdx = labels.indexOf("delivery");
    if (taxIdx >= 0 && taxIdx < values.length) totalTax = values[taxIdx];
    if (deliveryIdx >= 0 && deliveryIdx < values.length) totalShipping = values[deliveryIdx];
  }

  const items: ExtractedItem[] = [];

  const lines = text.split("\n");
  for (const line of lines) {
    if (!/^\d+\s*\t/.test(line)) continue;
    if (!/\$/.test(line)) continue;

    const cols = line.split("\t").map((c) => c.trim());
    const quantity = parseInt(cols[0]) || 1;
    let partNumber = "";
    let description = "";
    const prices: number[] = [];

    for (const col of cols.slice(1)) {
      const priceMatch = col.match(/^\$(\d+\.?\d*)/);
      if (priceMatch) { prices.push(parseFloat(priceMatch[1])); continue; }
      const pns = findPartNumbers(col);
      if (pns.length > 0 && !partNumber) { partNumber = pns[0]; continue; }
      if (/^\d+$/.test(col)) continue;
      if (col && !description) description = col;
    }

    if (partNumber || description) {
      items.push({
        partNumber,
        partName: description,
        quantity,
        unitPrice: prices[0] ?? null,
        shipCost: null,
        taxPrice: null,
        brand: null,
      });
    }
  }

  // Fallback if table parsing found nothing
  if (items.length === 0) {
    const partNumbers = findPartNumbers(text);
    const descMatch = text.match(/Description[\s\S]*?\t([A-Z][A-Z\s/\-,.]+)/);
    const description = descMatch?.[1]?.trim() ?? "";
    const priceMatch = text.match(/\$(\d+\.?\d{2})/);

    for (const pn of partNumbers) {
      items.push({
        partNumber: pn,
        partName: description,
        quantity: 1,
        unitPrice: priceMatch ? parseFloat(priceMatch[1]) : null,
        shipCost: null,
        taxPrice: null,
        brand: null,
      });
    }
  }

  // Distribute shipping and tax
  if (items.length > 0) {
    const perItemShip = round2(totalShipping / items.length);
    const perItemTax = round2(totalTax / items.length);
    for (const item of items) {
      item.shipCost = perItemShip;
      item.taxPrice = perItemTax;
    }
  }

  return {
    vendor: "marcone",
    orderNumber: invoiceMatch?.[1] ?? null,
    orderDate: dateMatch?.[1]?.trim() ?? null,
    technicianName,
    trackingNumber,
    deliveryCourier: null,
    items,
    rawText: text,
  };
}

// --- LLM Fallback ---

const ZAI_CHAT_URL = "https://api.z.ai/api/paas/v4/chat/completions";

async function parseFallback(text: string): Promise<DocumentResult> {
  const apiKey = process.env.ZAI_API_KEY;
  const empty: DocumentResult = {
    vendor: "unknown",
    orderNumber: null,
    orderDate: null,
    technicianName: null,
    trackingNumber: null,
    deliveryCourier: null,
    items: findPartNumbers(text).map((pn) => ({
      partNumber: pn,
      partName: "",
      quantity: 1,
      unitPrice: null,
      shipCost: null,
      taxPrice: null,
      brand: null,
    })),
    rawText: text,
  };

  if (!apiKey) return empty;

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
            content: `Extract all purchased items from this document. Reply with JSON: {"vendor":"...","orderNumber":"...","orderDate":"...","technicianName":"...","trackingNumber":"...","deliveryCourier":"...","items":[{"partNumber":"...","partName":"...","quantity":1,"unitPrice":null,"shipCost":null,"taxPrice":null,"brand":null}]}. Use null for unknown fields.\n\nDocument text:\n${text.slice(0, 3000)}`,
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
    return empty;
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

  const text = result.text.replace(/\f/g, "\n").trim();

  if (text.length < 20) {
    throw new Error("Document appears to be empty or image-only");
  }

  if (/amazon\.com/i.test(text)) return parseAmazon(text);
  if (/ebay/i.test(text) && /order number/i.test(text)) return parseEbay(text);
  if (/marcone/i.test(text)) return parseMarcone(text);

  return parseFallback(text);
}
