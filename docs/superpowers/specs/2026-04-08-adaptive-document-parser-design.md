# Adaptive Document Parser — Design Spec

## Goal

Replace the brittle vendor-specific template system with an adaptive parser that learns extraction templates from any invoice format on first encounter, then reuses them for free on subsequent invoices from the same vendor.

## Problem

The current parser only handles Amazon, eBay, and Marcone via hardcoded regex templates. Any other vendor (WCP, Miele, etc.) falls through to an LLM fallback that silently returns 0 items when the API key isn't available. Adding a new vendor requires code changes. This doesn't scale.

## Architecture

```
PDF bytes
  -> pdf-parse text extraction (free, instant)
  -> vendor detection (match domain/keywords against stored templates)
  -> known vendor? -> apply learned regex template (free, instant)
    -> 0 items extracted? -> template stale, fall through to LLM
  -> unknown vendor? -> LLM extracts data + generates template
    -> validate template against source text
    -> store template in DB for future use
    -> return extracted data
```

### Core Principles

1. **One system** -- every vendor uses the same template format and the same execution path. No hardcoded parsers, no special cases. Amazon, eBay, and Marcone are hand-crafted pre-seeded templates in the DB (translated from current regex logic), subject to the same fallback/regeneration as any learned template.
2. **Learn once, parse forever** -- first invoice from a new vendor costs one LLM call (~$0.0005). Every subsequent invoice from that vendor is free and instant.
3. **Templates are item-count agnostic** -- a template generated from a 1-item invoice works on a 50-item invoice. The row regex matches each row independently between table start/end markers.
4. **Graceful degradation** -- if ANY template fails (pre-seeded or learned), fall back to LLM, regenerate the template. No template is sacred.

## LLM Choice

**Model:** `gpt-5.4-nano` via OpenAI API
- Cost: $0.20/M input, $1.25/M output (~$0.0005 per invoice)
- Native structured output (`response_format: { type: "json_schema" }`) guarantees valid JSON matching our schema
- 400K token context window (invoices are tiny, ~500-2000 tokens)
- Designed specifically for data extraction, classification, and sub-agent tasks

**Environment variable:** `OPENAI_API_KEY`

**Fallback:** If no API key is set, return the raw text with a clear error message explaining that LLM extraction is required for unknown vendors. No more silent 0-item returns.

**Text cap:** Truncate extracted text to 10,000 characters before sending to the LLM. Invoice text is typically 500-2000 characters; anything beyond 10K is likely footer boilerplate, legal text, or a malformed PDF. This prevents token blowups and cost abuse.

**PII acknowledgement:** This is a self-hosted business tool. The user uploads their own invoices. Sending invoice text to OpenAI is the core feature — there is no way to extract structured data from arbitrary formats without an LLM seeing the text. The `rawText` field returned to the browser is explicitly requested by the user for debugging. The spec avoids persisting PII in the DB (no `sample_text` column) but does not attempt to redact text in transit — that would break extraction.

## Template Format

Based on the `invoice2data` pattern (2.2k GitHub stars, 100+ production templates). Regex for scalar fields, structural start/end markers + per-row regex for line items.

```json
{
  "vendorName": "West Coast Parts Distributing",
  "vendorSignals": {
    "domains": ["wcpdistributing.com"],
    "keywords": ["West Coast Parts Distributing"]
  },
  "fields": {
    "orderNumber": {
      "regex": "Invoice Number\\n(\\d+)",
      "group": 1
    },
    "orderDate": {
      "regex": "(\\d{2}/\\d{2}/\\d{4})",
      "group": 1
    },
    "trackingNumber": {
      "regex": "Tracking Number\\n(\\d{10,})",
      "group": 1
    },
    "technicianName": {
      "regex": "Ship To:.*?([A-Z][A-Z ]+VOSTRIKOV)",
      "group": 1
    },
    "courier": {
      "regex": "Ship Method\\n(\\w+)",
      "group": 1
    }
  },
  "lineItems": {
    "start": "Description.*Unit Price.*Extension",
    "end": "(?:Sub Total|Payment\\b)",
    "row": "per-row regex with named groups"
  },
  "totals": {
    "subtotal": "Sub Total[\\s\\t]*([\\d.]+)",
    "tax": "Tax[\\s\\S]*?([\\d.]+)",
    "shipping": "Shipping[\\s\\S]*?([\\d.]+)"
  }
}
```

### Field Definitions

| Field | Type | Description |
|-------|------|-------------|
| `vendorName` | string | Human-readable vendor name |
| `vendorSignals.domains` | string[] | Domains/URLs found in vendor's invoices |
| `vendorSignals.keywords` | string[] | Unique text strings identifying this vendor |
| `fields` | object | Regex + capture group for each scalar field |
| `lineItems.start` | string | Regex matching the table header row |
| `lineItems.end` | string | Regex matching where the table ends |
| `lineItems.row` | string | Per-row regex with named groups: `partNumber`, `description`, `quantity`, `unitPrice` |
| `totals` | object | Regex for subtotal, tax, shipping amounts |

### Named Groups in Row Regex

The row regex MUST use named capture groups: `(?<partNumber>...)`, `(?<description>...)`, `(?<quantity>...)`, `(?<unitPrice>...)`. Optional: `(?<brand>...)`, `(?<total>...)`.

This makes the template self-describing -- no separate column mapping needed.

## Database Schema

New table: `vendor_templates`

```sql
CREATE TABLE vendor_templates (
  id SERIAL PRIMARY KEY,
  vendor_name TEXT NOT NULL UNIQUE,
  vendor_domains TEXT[] NOT NULL DEFAULT '{}',
  vendor_keywords TEXT[] NOT NULL DEFAULT '{}',
  extraction_rules JSONB NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_vendor_templates_domains ON vendor_templates USING GIN (vendor_domains);
CREATE INDEX idx_vendor_templates_keywords ON vendor_templates USING GIN (vendor_keywords);
```

No `sample_text` column -- invoice text contains customer PII (names, addresses, tracking numbers). The template's extraction_rules are sufficient for debugging; storing the raw invoice text is unnecessary risk.

### Drizzle Schema

```typescript
export const vendorTemplates = pgTable("vendor_templates", {
  id: serial("id").primaryKey(),
  vendorName: text("vendor_name").notNull().unique(),
  vendorDomains: text("vendor_domains").array().notNull().default([]),
  vendorKeywords: text("vendor_keywords").array().notNull().default([]),
  extractionRules: jsonb("extraction_rules").notNull(),
  successCount: integer("success_count").notNull().default(0),
  failCount: integer("fail_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

## Vendor Detection

Priority-ordered cascade -- stop at first confident match:

1. **Domain match** -- extract all URLs/email domains from text, normalize to base domain, match against `vendor_domains` array. Catches ~70% of invoices.
2. **Keyword match** -- check if any `vendor_keywords` appear in the text (case-insensitive). Catches ~25% more.
3. **No match** -- new vendor, proceed to LLM extraction.

```typescript
function detectVendor(text: string, templates: VendorTemplate[]): VendorTemplate | null {
  const textLower = text.toLowerCase();

  // Extract domains from text
  const domainMatches = text.match(
    /(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.[a-z]{2,})/gi
  ) || [];
  const textDomains = domainMatches.map(d =>
    d.replace(/^(?:https?:\/\/)?(?:www\.)?/i, "").toLowerCase()
  );

  // Tier 1: domain match
  for (const tpl of templates) {
    if (tpl.vendorDomains.some(d => textDomains.includes(d.toLowerCase()))) {
      return tpl;
    }
  }

  // Tier 2: keyword match
  for (const tpl of templates) {
    if (tpl.vendorKeywords.some(k => textLower.includes(k.toLowerCase()))) {
      return tpl;
    }
  }

  return null;
}
```

## Regex Safety

LLM-generated regex runs on the request path. A pathological pattern (catastrophic backtracking) could lock the event loop. Mitigations:

1. **Use `re2`** (Google's RE2 engine, npm `re2`) for all template regex execution. RE2 guarantees linear-time matching by disallowing backreferences and other features that enable exponential blowup. It supports named capture groups, which is all we need.
2. **Validate at store time** -- when a template is generated, compile every regex with RE2. If any pattern fails to compile (uses unsupported features like lookaheads), reject the template and use LLM extraction directly.
3. **Execution timeout** -- wrap `applyTemplate()` in a 2-second deadline. If regex execution exceeds this, abort, increment `fail_count`, fall back to LLM. This is a safety net; RE2 should make it unnecessary in practice.
4. **LLM prompt constraint** -- the system prompt explicitly instructs: "Do NOT use lookaheads, lookbehinds, or backreferences. Use only basic regex features compatible with RE2."

**Package:** `re2` (npm, ~50k weekly downloads, Google-backed, native addon with prebuilt binaries for Linux/macOS).

## Template Application

```typescript
import RE2 from "re2";

const APPLY_TIMEOUT_MS = 2000;

function safeMatch(text: string, pattern: string, flags = ""): RegExpMatchArray | null {
  try {
    const re = new RE2(pattern, flags);
    return re.match(text);  // RE2 guarantees linear time
  } catch {
    return null;  // Invalid pattern, skip
  }
}

function applyTemplate(text: string, rules: ExtractionRules): DocumentResult {
  // 1. Extract scalar fields
  const fields: Record<string, string | null> = {};
  for (const [name, rule] of Object.entries(rules.fields)) {
    const m = safeMatch(text, rule.regex, "s");
    fields[name] = m?.[rule.group] ?? null;
  }

  // 2. Extract line items between start/end markers
  const items: ExtractedItem[] = [];
  const startMatch = safeMatch(text, rules.lineItems.start, "i");
  const endMatch = safeMatch(text, rules.lineItems.end, "i");

  if (startMatch && endMatch && startMatch.index != null && endMatch.index != null) {
    const tableText = text.slice(
      startMatch.index + startMatch[0].length,
      endMatch.index
    );
    try {
      const rowRe = new RE2(rules.lineItems.row, "gm");
      let match;
      while ((match = rowRe.exec(tableText)) !== null) {
        const g = match.groups;
        if (!g) continue;
        if (/payment/i.test(match[0])) continue;

        items.push({
          partNumber: g.partNumber?.trim() ?? "",
          partName: (g.description ?? g.partName ?? "").trim(),
          quantity: parseInt(g.quantity) || 1,
          unitPrice: g.unitPrice ? parseFloat(g.unitPrice) : null,
          shipCost: null,
          taxPrice: null,
          brand: g.brand?.trim() ?? null,
        });
      }
    } catch {
      // Invalid row pattern, return 0 items (will trigger LLM fallback)
    }
  }

  // 3. Extract totals and distribute proportionally
  const tax = extractTotal(text, rules.totals?.tax);
  const shipping = extractTotal(text, rules.totals?.shipping);

  if (tax > 0 || shipping > 0) {
    distributeAndNormalize(items, shipping, tax);
  }

  return { vendor: "...", orderNumber: fields.orderNumber ?? null, ... };
}
```

## LLM Extraction + Template Generation

Single API call that returns both the extracted data AND a reusable template.

### System Prompt

```
You extract purchase order data from document text AND generate a reusable regex-based extraction template for this vendor's invoice format.

CRITICAL rules for the template:
- All regex patterns use RE2-compatible syntax (no lookaheads, lookbehinds, or backreferences)
- Line item row patterns MUST use named capture groups: (?<partNumber>...), (?<description>...), (?<quantity>...), (?<unitPrice>...)
- Row patterns must match ANY number of item rows, not just the ones in this document
- NEVER hardcode literal values from this invoice (part numbers, prices, names) into regex patterns. Use character classes like \d+, \S+, [^\t]+, .+? instead
- Use \s+ instead of literal spaces for flexible whitespace matching
- Escape special regex characters properly
- lineItems.start should match the TABLE HEADER row (column labels)
- lineItems.end should match text AFTER the last item row (subtotal, total, payment terms, etc.)
- Do NOT match payment lines, subtotal lines, or footer text with the row pattern
- For vendor signals, extract the company domain and a unique identifying phrase
```

### User Prompt

```
Extract all purchased items from this invoice and generate a reusable regex template for this vendor's format.

Document text:
{full extracted text}
```

### Response Schema (enforced via OpenAI structured outputs)

```json
{
  "type": "object",
  "properties": {
    "extraction": {
      "type": "object",
      "properties": {
        "vendor": { "type": "string" },
        "orderNumber": { "type": ["string", "null"] },
        "orderDate": { "type": ["string", "null"] },
        "technicianName": { "type": ["string", "null"] },
        "trackingNumber": { "type": ["string", "null"] },
        "deliveryCourier": { "type": ["string", "null"] },
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "partNumber": { "type": "string" },
              "partName": { "type": "string" },
              "quantity": { "type": "number" },
              "unitPrice": { "type": ["number", "null"] },
              "brand": { "type": ["string", "null"] }
            },
            "required": ["partNumber", "partName", "quantity", "unitPrice", "brand"]
          }
        }
      },
      "required": ["vendor", "orderNumber", "orderDate", "technicianName", "trackingNumber", "deliveryCourier", "items"]
    },
    "template": {
      "type": "object",
      "properties": {
        "vendorName": { "type": "string" },
        "vendorSignals": {
          "type": "object",
          "properties": {
            "domains": { "type": "array", "items": { "type": "string" } },
            "keywords": { "type": "array", "items": { "type": "string" } }
          },
          "required": ["domains", "keywords"]
        },
        "fields": {
          "type": "object",
          "additionalProperties": {
            "type": "object",
            "properties": {
              "regex": { "type": "string" },
              "group": { "type": "number" }
            },
            "required": ["regex", "group"]
          }
        },
        "lineItems": {
          "type": "object",
          "properties": {
            "start": { "type": "string" },
            "end": { "type": "string" },
            "row": { "type": "string" }
          },
          "required": ["start", "end", "row"]
        },
        "totals": {
          "type": "object",
          "additionalProperties": { "type": "string" }
        }
      },
      "required": ["vendorName", "vendorSignals", "fields", "lineItems", "totals"]
    }
  },
  "required": ["extraction", "template"]
}
```

## Template Validation

Two-phase validation: structural checks (catch hardcoded/non-generic patterns) + extraction check (verify it works on this invoice).

### Phase 1: Structural Validation (catches non-generalizable templates)

Before even running the template, check that it's generic. These checks apply to ALL regex patterns -- row regex, scalar field patterns, and totals patterns alike.

1. **No literal values from the invoice** -- collect all extracted values from the LLM response (part numbers, prices, order number, tracking number, technician name, dates). Check that NONE of these literal values appear in ANY regex pattern (fields, row, totals). If the LLM extracted orderNumber "743106" and the orderNumber field regex contains the literal `743106`, reject. If technicianName is "SERGEY VOSTRIKOV" and the technicianName regex contains `VOSTRIKOV`, reject. This catches the most common LLM failure: overfitting to the specific invoice.
2. **Named groups present** -- the row regex must contain `(?<partNumber>`, `(?<quantity>`, and `(?<unitPrice>` named groups at minimum.
3. **RE2 compatibility** -- all regex patterns (fields, lineItems, totals) must compile under RE2. Reject if any pattern uses lookaheads, lookbehinds, or backreferences.
4. **Character class heuristic (row regex only)** -- for the `lineItems.row` pattern only, if more than 40% of the pattern is literal alphanumeric characters (excluding regex metacharacters), flag it as potentially non-generic and reject. This check does NOT apply to field patterns or totals patterns, which naturally contain label text like "Invoice Number" or "Sub Total" that is expected to be literal.

### Phase 2: Extraction Validation (verify it works on this invoice)

1. Apply the template to the source text using `applyTemplate()`
2. Compare against LLM extraction:
   - At least as many items as the LLM found?
   - Part numbers match (order-independent)?
   - Prices match within $0.01?
3. **Pass both phases**: store the template, return LLM extraction
4. **Fail either phase**: return LLM extraction to user anyway, do NOT store the template, log the specific failure reason for debugging

### Validation is necessary but not sufficient

Same-invoice validation cannot fully prove a template generalizes to other invoices from the same vendor. The structural checks (Phase 1) catch the most common failure mode (literal value hardcoding). Beyond that, the staleness mechanism (fail_count/success_count) provides the safety net: if a template fails on a future invoice, it gets regenerated automatically.

## Template Staleness and Regeneration

### Counter semantics

- **`success_count`** -- incremented each time the template extracts >= 1 item from a matching invoice
- **`fail_count`** -- incremented each time the template extracts 0 items from a matching invoice
- **On regeneration** -- when a new template replaces an old one, both counters reset to 0. The new template must earn its own track record.

### Staleness logic

- When a stored template extracts 0 items from a document matching its vendor signals: increment `fail_count`, fall back to LLM for extraction only (do NOT regenerate the template on a single failure)
- **Regeneration is only allowed when the template is already unreliable:** `fail_count > 3` AND `success_count < fail_count`. Only then does the LLM regeneration path overwrite the existing template.
- For a single failure on an otherwise-healthy template (success_count >= fail_count), the LLM extracts data for the user but the existing template is preserved. This prevents template poisoning: a PDF that happens to mention "amazon.com" in its text but is from a different vendor cannot clobber the Amazon template on a single mismatch.
- `updated_at` is set on every counter update and on regeneration

## Amazon, eBay, Marcone — Pre-seeded Templates

The existing hardcoded parsers (`parseAmazon`, `parseEbay`, `parseMarcone`) are deleted. Their extraction logic is translated into the template format and pre-seeded as rows in `vendor_templates` during migration.

**Why this works:**
- The template format (regex fields + table start/end + row regex + totals) can express everything the hardcoded parsers do
- Amazon per-shipment tax: the template's totals regex targets per-shipment tax/shipping blocks. The `distributeAndNormalize()` math stays the same.
- Marcone stacked labels: the totals regex handles the label/value block pattern
- eBay multi-seller: the start/end markers scope to each seller section

**If a pre-seeded template fails:** same path as any other template. Increment `fail_count`, fall back to LLM, regenerate. The LLM sees the actual text and produces a template that matches the current format. No template is permanent — vendors change their invoices, and the system adapts.

**Pre-seed data is committed as a migration** with the hand-crafted template JSON for each vendor. This is the regression test: if the migration data is wrong, the first upload from that vendor will fail, trigger LLM regeneration, and self-correct.

```
PDF text
  -> check vendor_templates DB (includes pre-seeded Amazon/eBay/Marcone)
  -> template found? -> applyTemplate()
    -> 0 items? -> LLM regenerate
  -> no template? -> LLM extract + learn
```

## Tax/Shipping Distribution

The existing `distributeAndNormalize()` function is kept unchanged. It's vendor-agnostic:

1. Compute subtotal (sum of unitPrice * quantity for all items)
2. Each item's fraction = lineTotal / subtotal
3. Proportional share of shipping and tax per line item
4. Normalize all prices to per-unit (divide by quantity)

## API Changes

### `POST /api/parts/import` -> SSE Streaming

The endpoint switches from a JSON response to **Server-Sent Events (SSE)**. This lets the frontend show each step live as it happens.

**Request:** unchanged — `{ document: string }` (base64 PDF), `Content-Type: application/json`

**Response:** `Content-Type: text/event-stream`

Each step emits an SSE event:

```
event: step
data: {"step":"extracting_text","message":"Extracting text from PDF..."}

event: step
data: {"step":"detecting_vendor","message":"Searching for vendor template..."}

event: step
data: {"step":"vendor_matched","message":"Vendor matched: West Coast Parts Distributing"}

event: step
data: {"step":"applying_template","message":"Applying learned template..."}

event: result
data: {"vendor":"West Coast Parts Distributing","orderNumber":"743106","items":[...],"rawText":"...","steps":[...]}

```

Or for a new vendor:

```
event: step
data: {"step":"extracting_text","message":"Extracting text from PDF..."}

event: step
data: {"step":"detecting_vendor","message":"Searching for vendor template..."}

event: step
data: {"step":"no_template","message":"New vendor detected. Learning template via LLM..."}

event: step
data: {"step":"llm_extracting","message":"Sending to gpt-5.4-nano for extraction + template generation..."}

event: step
data: {"step":"validating_template","message":"Validating generated template..."}

event: step
data: {"step":"template_stored","message":"Template learned and stored. Future invoices from this vendor will be instant."}

event: result
data: {"vendor":"Miele","orderNumber":"3012683180","items":[...],"rawText":"...","steps":[...]}

```

Or on error:

```
event: error
data: {"error":"No extraction template for this vendor. Set OPENAI_API_KEY to enable automatic template learning."}

```

### SSE Event Types

| Event | Data | When |
|-------|------|------|
| `step` | `{ step: string, message: string }` | Each processing stage |
| `result` | Full `DocumentResult` + `steps` array | Extraction complete |
| `error` | `{ error: string }` | Unrecoverable failure |

### Step IDs

| Step ID | Message | Condition |
|---------|---------|-----------|
| `extracting_text` | "Extracting text from PDF..." | Always |
| `detecting_vendor` | "Searching for vendor template..." | Always |
| `vendor_matched` | "Vendor matched: {name}" | Template found |
| `applying_template` | "Applying learned template..." | Template found |
| `template_failed` | "Template extraction failed. Falling back to LLM..." | Template returned 0 items |
| `no_template` | "New vendor detected. Learning template via LLM..." | No template match |
| `llm_extracting` | "Sending to gpt-5.4-nano for extraction + template generation..." | LLM path |
| `validating_template` | "Validating generated template..." | After LLM response |
| `template_stored` | "Template learned and stored. Future invoices from this vendor will be instant." | Validation passed |
| `template_validation_failed` | "Template validation failed. Using LLM extraction directly." | Validation failed |
| `done` | "{n} items extracted" | Always (final step before result) |

### Backend Implementation

```typescript
router.post("/import", requireScope("parts:write"), async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  function sendStep(step: string, message: string) {
    res.write(`event: step\ndata: ${JSON.stringify({ step, message })}\n\n`);
  }

  function sendResult(result: DocumentResult & { steps: string[] }) {
    res.write(`event: result\ndata: ${JSON.stringify(result)}\n\n`);
    res.end();
  }

  function sendError(error: string) {
    res.write(`event: error\ndata: ${JSON.stringify({ error })}\n\n`);
    res.end();
  }

  // Abort on client disconnect to avoid wasted LLM calls
  const abort = new AbortController();
  req.on("close", () => abort.abort());

  // ... extraction logic calls sendStep() at each stage
  // Pass abort.signal to the OpenAI call; check abort.signal.aborted before expensive ops
});
```

### Frontend Implementation

SSE bypasses the `api()` client (which handles JSON responses, GET dedupe, and 401 refresh). To maintain auth parity:

1. **Use `getAccessToken()` and `refreshAccessToken()`** exported from `client.ts` to get a valid token before opening the stream
2. **Check `response.ok` before reading the stream** -- a 401 means the token expired; refresh and retry once
3. **On non-2xx non-401, parse JSON error** from the response body (not SSE)

```typescript
import { getAccessToken, refreshAccessToken } from "../api/client";

async function processFile(file: File) {
  const base64 = await fileToBase64(file);
  const body = JSON.stringify({ document: base64 });

  async function doRequest(token: string): Promise<Response> {
    return fetch("/api/parts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body,
    });
  }

  let token = getAccessToken();
  if (!token) throw new Error("Not authenticated");

  let response = await doRequest(token);

  // Handle 401: refresh token and retry once
  if (response.status === 401) {
    token = await refreshAccessToken();
    if (!token) throw new Error("Session expired");
    response = await doRequest(token);
  }

  // Non-2xx: read JSON error body
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Import failed" }));
    throw new Error(err.error || `HTTP ${response.status}`);
  }

  // 200 OK: read SSE stream
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n\n");
    buffer = events.pop()!;

    for (const event of events) {
      const typeMatch = event.match(/^event: (\w+)/);
      const dataMatch = event.match(/^data: (.+)$/m);
      if (!typeMatch || !dataMatch) continue;

      const type = typeMatch[1];
      const data = JSON.parse(dataMatch[1]);

      if (type === "step") addStep(data);
      if (type === "result") setResult(data);
      if (type === "error") setError(data.error);
    }
  }
}
```

This requires exporting `getAccessToken` and `refreshAccessToken` from `client.ts`. The `refreshAccessToken` function calls `POST /api/auth/refresh`, updates the stored token, and returns it (or null if the session is dead).

### Frontend Steps UI

Steps display as a vertical list above the results. Each step appears in real-time with a small status indicator:

- Active step: spinner
- Completed step: checkmark
- The list grows as events arrive

```
[check] Extracting text from PDF...
[check] Searching for vendor template...
[check] New vendor detected. Learning template via LLM...
[check] Sending to gpt-5.4-nano for extraction + template generation...
[check] Validating generated template...
[check] Template learned and stored. Future invoices from this vendor will be instant.
[check] 2 items extracted
```

Steps remain visible after extraction completes, above the item data. This gives full transparency into what happened.

### No new endpoints needed

Template management is fully automatic. No manual CRUD -- the system learns from usage.

## File Changes

| File | Change |
|------|--------|
| `backend/src/db/schema.ts` | Add `vendorTemplates` table |
| `backend/drizzle/0005_*.sql` | Migration for new table |
| `backend/src/services/document-parser.ts` | Rewrite: keep Amazon/eBay/Marcone parsers, add vendor detection, template application, LLM extraction+learning. Remove old LLM fallback (ZAI). |
| `backend/src/routes/parts.ts` | SSE streaming for import endpoint, error handling for missing API key |
| `backend/package.json` | Add `openai` and `re2` packages |
| `frontend/src/api/client.ts` | Export `getAccessToken` and `refreshAccessToken` for SSE auth |
| `frontend/src/pages/ImportDocument.tsx` | Rewrite upload flow to use SSE with auth retry, add live steps UI |

## Out of Scope (v1)

- Manual template editing UI
- Template versioning/history
- Multi-page invoice support (split across pages)
- Template sharing/export between instances
- Batch import (multiple PDFs at once)
- OCR for image-only PDFs (current behavior: throw error)

## Success Criteria

1. Upload a WCP invoice (never seen before) -> LLM extracts correctly -> template stored
2. Upload a second WCP invoice -> template applied (no LLM call) -> items extracted correctly
3. Upload a Miele invoice -> same learn-then-reuse flow
4. Amazon/eBay/Marcone invoices work via pre-seeded templates (no LLM call)
5. 1-item invoice template works on multi-item invoice from same vendor
6. Template failure -> automatic LLM fallback -> template regenerated
