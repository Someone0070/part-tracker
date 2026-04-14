/**
 * Text preprocessing for LLM calls.
 *
 * Strips corporate boilerplate, legal prose, payment lines, and other noise
 * from PDF/OCR text before sending to LLM extraction. Template regex matching
 * and vendor detection still use raw text -- only LLM calls use stripped text.
 */

// --- Patterns ---

const DOLLAR_AMOUNT = /\$\d[\d,.]*|\b\d[\d,.]*\s*(?:USD|dollars?)/i;
const DATE_PATTERN =
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
// key:value structure: one or more words followed by colon then a short value (or end of line)
const KEY_VALUE = /^[A-Za-z][A-Za-z0-9 \/\-#&'.]*:\s*.{0,60}$/;

const BOILERPLATE_HEADERS =
  /^(?:TERMS|RETURNS|WARRANTY|Return Policy|Remit to|ACH|Wire Info)\s*:?\s*$/i;

const PAYMENT_LINE = /\b(?:VISA|Mastercard|MasterCard|Amex|PayPal|payment)\b/i;

const PAGE_MARKER = /^(?:--\s*\d+\s+of\s+\d+\s*--|Page\s+\d+(?:\s+of\s+\d+)?)\s*$/i;

const PHONE = /\(\d{3}\)\s*\d{3}[-.\s]\d{4}/;
const CONTACT_LINE = /\b(?:fax|www\.|website|telephone)\b/i;

const SHIP_TO_HEADER = /^(?:Ship\s+To|Deliver\s+To)\s*:/i;

// OCR separator produced by document-parser.ts
const OCR_SEPARATOR = "--- OCR-enhanced text ---";

// --- Helpers ---

function normWs(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Returns true when the line contains a dollar amount paired with a payment keyword.
 */
function isPaymentLine(line: string): boolean {
  return PAYMENT_LINE.test(line) && DOLLAR_AMOUNT.test(line);
}

/**
 * Returns true when a line is "legal prose": > 80 chars, no dollar amount,
 * no date, no key:value structure.
 */
function isLegalProse(line: string): boolean {
  if (line.length <= 80) return false;
  if (DOLLAR_AMOUNT.test(line)) return false;
  if (DATE_PATTERN.test(line)) return false;
  if (KEY_VALUE.test(line)) return false;
  return true;
}

// --- stripBoilerplate ---

export function stripBoilerplate(text: string): string {
  // Handle OCR deduplication first
  const ocrSepIdx = text.indexOf(OCR_SEPARATOR);
  let pdfSection = text;
  let ocrSection = "";

  if (ocrSepIdx !== -1) {
    pdfSection = text.slice(0, ocrSepIdx);
    ocrSection = text.slice(ocrSepIdx + OCR_SEPARATOR.length).trimStart();
  }

  const pdfLines = pdfSection.split("\n");

  // Build a set of normalized pdf-parse lines for dedup
  const pdfNormed = new Set<string>(pdfLines.map((l) => normWs(l)).filter((l) => l.length > 0));

  // Deduplicate OCR lines against pdf-parse lines (near-exact: normalized match)
  let ocrUnique = "";
  if (ocrSection) {
    const ocrLines = ocrSection.split("\n");
    const kept = ocrLines.filter((line) => {
      const n = normWs(line);
      if (n.length === 0) return true; // preserve blank lines
      return !pdfNormed.has(n);
    });
    ocrUnique = kept.join("\n");
  }

  // Now process the pdf-parse lines
  const output: string[] = [];
  let skipUntilBlankOrHeader = false;
  let afterShipTo = false;

  // Track a sliding window for contact block detection
  // We mark lines as "contact-type" and flush them only when we hit a non-contact line
  const contactBuffer: string[] = [];

  function flushContact(keepAll: boolean) {
    if (keepAll) {
      for (const l of contactBuffer) output.push(l);
    }
    // if not keepAll, discard
    contactBuffer.length = 0;
  }

  for (const line of pdfLines) {
    const trimmed = line.trim();

    // --- OCR separator line itself: skip ---
    if (trimmed === OCR_SEPARATOR.trim()) {
      continue;
    }

    // --- Track Ship To / Deliver To headers ---
    if (SHIP_TO_HEADER.test(trimmed)) {
      afterShipTo = true;
      flushContact(true);
      output.push(line);
      continue;
    }

    // Reset ship-to guard on blank lines (address block ends)
    if (trimmed === "") {
      afterShipTo = false;
    }

    // --- Boilerplate section headers: skip header + body ---
    if (BOILERPLATE_HEADERS.test(trimmed)) {
      skipUntilBlankOrHeader = true;
      flushContact(false);
      continue;
    }

    if (skipUntilBlankOrHeader) {
      if (trimmed === "" || BOILERPLATE_HEADERS.test(trimmed)) {
        skipUntilBlankOrHeader = false;
        if (trimmed === "") {
          output.push(line); // keep the blank
        } else {
          // It's a new boilerplate header — start skipping again
          skipUntilBlankOrHeader = true;
        }
      }
      // else: still inside boilerplate section, skip
      continue;
    }

    // --- Page markers ---
    if (PAGE_MARKER.test(trimmed)) {
      flushContact(false);
      continue;
    }

    // --- Payment lines ---
    if (isPaymentLine(trimmed)) {
      flushContact(false);
      continue;
    }

    // --- Legal prose ---
    if (isLegalProse(trimmed)) {
      flushContact(false);
      continue;
    }

    // --- Corporate contact block detection ---
    // Lines with phone, fax, www., website, telephone keywords are "contact-type"
    // We buffer them; if we accumulate 2+ consecutive, we drop the block.
    // But ship-to address lines are exempt.
    if (!afterShipTo && (PHONE.test(trimmed) || CONTACT_LINE.test(trimmed))) {
      contactBuffer.push(line);
      continue;
    }

    // Non-contact line: decide what to do with buffered contact lines
    if (contactBuffer.length >= 2) {
      // It's a contact block -- discard
      contactBuffer.length = 0;
    } else {
      flushContact(true);
    }

    output.push(line);
  }

  // Flush any remaining contact buffer
  if (contactBuffer.length >= 2) {
    contactBuffer.length = 0;
  } else {
    flushContact(true);
  }

  let result = output.join("\n");

  // Append deduplicated OCR content if any
  if (ocrUnique.trim().length > 0) {
    result = result + "\n\n" + OCR_SEPARATOR + "\n" + ocrUnique;
  }

  return result;
}

// --- stripForFillIn ---

const STREET_LINE = /^\d+\s+\S.*(?:st(?:reet)?|ave(?:nue)?|blvd|boulevard|rd|road|dr(?:ive)?|ln|lane|way|ct|court|pl(?:ace)?|hwy|highway|pkwy|parkway)\b/i;
const CITY_STATE_ZIP = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/;

/**
 * Further strips cleanText for nano fill-in calls when template was used.
 * Removes matched item rows and address blocks (except ship-to name).
 */
export function stripForFillIn(cleanText: string, matchedRowLines: string[]): string {
  const matchedSet = new Set(matchedRowLines.map((l) => l.trim()));

  const lines = cleanText.split("\n");
  const output: string[] = [];

  let afterShipTo = false;
  let shipToNameConsumed = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Track Ship To header: keep it and the next non-blank line (the name).
    // If the header has an inline name ("Ship To: John Doe"), the name is already
    // consumed -- subsequent lines are address lines to be stripped.
    if (SHIP_TO_HEADER.test(trimmed)) {
      afterShipTo = true;
      // Check if there's inline content after the colon (i.e. name on same line)
      const colonIdx = trimmed.indexOf(":");
      const afterColon = colonIdx !== -1 ? trimmed.slice(colonIdx + 1).trim() : "";
      shipToNameConsumed = afterColon.length > 0;
      output.push(line);
      continue;
    }

    if (afterShipTo) {
      if (trimmed === "") {
        // blank within ship-to block -- keep and continue
        output.push(line);
        continue;
      }
      if (!shipToNameConsumed) {
        // First non-blank after Ship To: is the name -- keep it
        output.push(line);
        shipToNameConsumed = true;
        continue;
      }
      // Subsequent lines in ship-to block: check if address-like, skip them
      if (STREET_LINE.test(trimmed) || CITY_STATE_ZIP.test(trimmed)) {
        continue; // address line after name -- drop it
      }
      // Non-address line ends the ship-to block
      afterShipTo = false;
    }

    // --- Remove matched item rows ---
    if (matchedSet.has(trimmed)) {
      continue;
    }

    // --- Remove address blocks (not in ship-to context) ---
    if (STREET_LINE.test(trimmed) || CITY_STATE_ZIP.test(trimmed)) {
      continue;
    }

    output.push(line);
  }

  return output.join("\n");
}
