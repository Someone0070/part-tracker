# Adaptive Document Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded vendor parsers with a learn-once-parse-forever adaptive template system that uses LLM extraction for new vendors and stores reusable regex templates in the DB.

**Architecture:** PDF text extraction (pdf-parse) -> vendor detection against DB templates -> if match, apply regex template (free); if no match, LLM extracts data + generates a regex template, validates it, stores it. SSE streams each step to the frontend in real-time.

**Tech Stack:** TypeScript, Express, Drizzle ORM, PostgreSQL, OpenAI gpt-5.4-nano (structured outputs), re2 (safe regex), pdf-parse, SSE (Server-Sent Events)

**Spec:** `docs/superpowers/specs/2026-04-08-adaptive-document-parser-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `backend/src/db/schema.ts` | Add `vendorTemplates` table definition |
| `backend/drizzle/0005_vendor_templates.sql` | Migration SQL + journal entry |
| `backend/src/services/template-types.ts` | NEW -- Shared types: `ExtractionRules`, `VendorTemplate`, `DocumentResult`, `ExtractedItem` |
| `backend/src/services/template-apply.ts` | NEW -- `applyTemplate()`, `safeMatch()`, `extractTotal()`, `distributeAndNormalize()` |
| `backend/src/services/template-validate.ts` | NEW -- `validateTemplate()` (structural + extraction phases) |
| `backend/src/services/template-llm.ts` | NEW -- `llmExtractAndLearn()` -- OpenAI call, schema, prompts |
| `backend/src/services/vendor-detect.ts` | NEW -- `detectVendor()`, `loadTemplates()` |
| `backend/src/services/document-parser.ts` | REWRITE -- Thin orchestrator: text extraction, vendor detect, template apply or LLM, with SSE callbacks |
| `backend/src/routes/parts.ts` | Modify import endpoint to SSE |
| `frontend/src/api/client.ts` | Export `refreshAccessToken` (change from private to export) |
| `frontend/src/pages/ImportDocument.tsx` | SSE stream reader + live steps UI |

---

### Task 1: Install dependencies

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Install openai and re2 packages**

```bash
cd backend && npm install openai re2
```

- [ ] **Step 2: Verify packages installed**

```bash
node -e "const RE2 = require('re2'); const r = new RE2('test'); console.log('RE2 OK')"
node -e "const { OpenAI } = require('openai'); console.log('OpenAI OK')"
```

Expected: both print "OK" with no errors.

- [ ] **Step 3: Verify TypeScript can see the types**

```bash
cd backend && npx tsc --noEmit 2>&1 | head -5
```

Expected: clean compilation (no new errors).

- [ ] **Step 4: Commit**

```bash
git add backend/package.json backend/package-lock.json
git commit -m "chore: add openai and re2 dependencies"
```

---

### Task 2: Database migration -- vendor_templates table

**Files:**
- Modify: `backend/src/db/schema.ts`
- Create: `backend/drizzle/0005_vendor_templates.sql`
- Modify: `backend/drizzle/meta/_journal.json`

- [ ] **Step 1: Add vendorTemplates to Drizzle schema**

Add to the end of `backend/src/db/schema.ts`, after the `sessions` table:

```typescript
export const vendorTemplates = pgTable("vendor_templates", {
  id: serial("id").primaryKey(),
  vendorName: text("vendor_name").notNull(),
  vendorDomains: text("vendor_domains").array().notNull().default(sql`'{}'::text[]`),
  vendorKeywords: text("vendor_keywords").array().notNull().default(sql`'{}'::text[]`),
  extractionRules: text("extraction_rules").notNull(), // JSON string, parsed at runtime
  successCount: integer("success_count").notNull().default(0),
  failCount: integer("fail_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Note: Using `text` for `extractionRules` instead of `jsonb` to avoid Drizzle JSONB typing issues. We parse it ourselves.

- [ ] **Step 2: Create migration SQL**

Create `backend/drizzle/0005_vendor_templates.sql`:

```sql
CREATE TABLE "vendor_templates" (
  "id" serial PRIMARY KEY NOT NULL,
  "vendor_name" text NOT NULL,
  "vendor_domains" text[] NOT NULL DEFAULT '{}'::text[],
  "vendor_keywords" text[] NOT NULL DEFAULT '{}'::text[],
  "extraction_rules" text NOT NULL,
  "success_count" integer NOT NULL DEFAULT 0,
  "fail_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "idx_vendor_templates_domains" ON "vendor_templates" USING GIN ("vendor_domains");
CREATE INDEX "idx_vendor_templates_keywords" ON "vendor_templates" USING GIN ("vendor_keywords");
```

- [ ] **Step 3: Add journal entry**

Add to the `entries` array in `backend/drizzle/meta/_journal.json`:

```json
{
  "idx": 5,
  "version": "7",
  "when": 1775683200000,
  "tag": "0005_vendor_templates",
  "breakpoints": true
}
```

- [ ] **Step 4: Verify schema compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: clean compilation.

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/schema.ts backend/drizzle/0005_vendor_templates.sql backend/drizzle/meta/_journal.json
git commit -m "feat: add vendor_templates table for adaptive document parsing"
```

---

### Task 3: Shared types -- template-types.ts

**Files:**
- Create: `backend/src/services/template-types.ts`

- [ ] **Step 1: Create the types file**

Create `backend/src/services/template-types.ts`:

```typescript
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

export interface FieldRule {
  regex: string;
  group: number;
}

export interface ExtractionRules {
  vendorName: string;
  vendorSignals: {
    domains: string[];
    keywords: string[];
  };
  fields: Record<string, FieldRule>;
  lineItems: {
    start: string;
    end: string;
    row: string;
  };
  totals: Record<string, string>;
}

export interface VendorTemplate {
  id: number;
  vendorName: string;
  vendorDomains: string[];
  vendorKeywords: string[];
  extractionRules: ExtractionRules;
  successCount: number;
  failCount: number;
}

export type StepCallback = (step: string, message: string) => void;
```

- [ ] **Step 2: Verify compiles**

```bash
cd backend && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/template-types.ts
git commit -m "feat: add shared types for adaptive template system"
```

---

### Task 4: Template application -- template-apply.ts

**Files:**
- Create: `backend/src/services/template-apply.ts`

- [ ] **Step 1: Create the template application module**

Create `backend/src/services/template-apply.ts`:

```typescript
import RE2 from "re2";
import type { ExtractedItem, ExtractionRules, DocumentResult } from "./template-types.js";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function distributeAndNormalize(
  items: ExtractedItem[],
  totalShipping: number,
  totalTax: number
): void {
  const subtotal = items.reduce(
    (sum, item) => sum + (item.unitPrice ?? 0) * item.quantity,
    0
  );

  for (const item of items) {
    const lineTotal = (item.unitPrice ?? 0) * item.quantity;
    const fraction = subtotal > 0 ? lineTotal / subtotal : 1 / items.length;

    const lineShip = round2(totalShipping * fraction);
    const lineTax = round2(totalTax * fraction);

    const qty = item.quantity || 1;
    item.unitPrice = item.unitPrice != null ? round2(item.unitPrice) : null;
    item.shipCost = round2(lineShip / qty);
    item.taxPrice = round2(lineTax / qty);
  }
}

export function safeMatch(text: string, pattern: string, flags = ""): RegExpMatchArray | null {
  try {
    const re = new RE2(pattern, flags);
    return text.match(re);
  } catch {
    return null;
  }
}

function extractTotal(text: string, pattern: string | undefined): number {
  if (!pattern) return 0;
  const m = safeMatch(text, pattern, "s");
  return m?.[1] ? parseFloat(m[1]) : 0;
}

export function applyTemplate(
  text: string,
  rules: ExtractionRules
): DocumentResult {
  // 1. Extract scalar fields
  const fields: Record<string, string | null> = {};
  for (const [name, rule] of Object.entries(rules.fields)) {
    const m = safeMatch(text, rule.regex, "s");
    fields[name] = m?.[rule.group] ?? null;
  }

  // 2. Extract line items between start/end markers
  const items: ExtractedItem[] = [];
  const startMatch = safeMatch(text, rules.lineItems.start, "i");

  if (startMatch && startMatch.index != null) {
    const afterStart = text.slice(startMatch.index + startMatch[0].length);
    const endMatch = safeMatch(afterStart, rules.lineItems.end, "i");
    const tableText = endMatch && endMatch.index != null
      ? afterStart.slice(0, endMatch.index)
      : afterStart;

    try {
      const rowRe = new RE2(rules.lineItems.row, "g");
      let match;
      while ((match = rowRe.exec(tableText)) !== null) {
        const g = match.groups as Record<string, string> | undefined;
        if (!g) continue;
        if (/payment/i.test(match[0])) continue;

        items.push({
          partNumber: g["partNumber"]?.trim() ?? "",
          partName: (g["description"] ?? g["partName"] ?? "").trim(),
          quantity: parseInt(g["quantity"]) || 1,
          unitPrice: g["unitPrice"] ? parseFloat(g["unitPrice"]) : null,
          shipCost: null,
          taxPrice: null,
          brand: g["brand"]?.trim() ?? null,
        });
      }
    } catch {
      // Invalid row pattern -- return 0 items (triggers LLM fallback)
    }
  }

  // 3. Extract totals and distribute proportionally
  const tax = extractTotal(text, rules.totals["tax"]);
  const shipping = extractTotal(text, rules.totals["shipping"]);

  if (tax > 0 || shipping > 0) {
    distributeAndNormalize(items, shipping, tax);
  }

  return {
    vendor: rules.vendorName,
    orderNumber: fields["orderNumber"] ?? null,
    orderDate: fields["orderDate"] ?? null,
    technicianName: fields["technicianName"] ?? null,
    trackingNumber: fields["trackingNumber"] ?? null,
    deliveryCourier: fields["courier"] ?? null,
    items,
    rawText: text,
  };
}
```

- [ ] **Step 2: Verify compiles**

```bash
cd backend && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/template-apply.ts
git commit -m "feat: template application engine with RE2 safe regex"
```

---

### Task 5: Template validation -- template-validate.ts

**Files:**
- Create: `backend/src/services/template-validate.ts`

- [ ] **Step 1: Create the validation module**

Create `backend/src/services/template-validate.ts`:

```typescript
import RE2 from "re2";
import type { ExtractionRules } from "./template-types.js";
import { applyTemplate } from "./template-apply.js";

interface LlmExtraction {
  vendor: string;
  orderNumber: string | null;
  orderDate: string | null;
  technicianName: string | null;
  trackingNumber: string | null;
  deliveryCourier: string | null;
  items: Array<{
    partNumber: string;
    partName: string;
    quantity: number;
    unitPrice: number | null;
    brand: string | null;
  }>;
}

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

function collectLiterals(extraction: LlmExtraction): string[] {
  const literals: string[] = [];
  if (extraction.orderNumber) literals.push(extraction.orderNumber);
  if (extraction.orderDate) literals.push(extraction.orderDate);
  if (extraction.technicianName) literals.push(extraction.technicianName);
  if (extraction.trackingNumber) literals.push(extraction.trackingNumber);
  if (extraction.deliveryCourier) literals.push(extraction.deliveryCourier);
  for (const item of extraction.items) {
    if (item.partNumber) literals.push(item.partNumber);
    if (item.partName && item.partName.length > 3) literals.push(item.partName);
    if (item.unitPrice != null) literals.push(String(item.unitPrice));
  }
  return literals.filter((v) => v.length > 2);
}

function collectPatterns(rules: ExtractionRules): string[] {
  const patterns: string[] = [];
  for (const rule of Object.values(rules.fields)) {
    patterns.push(rule.regex);
  }
  patterns.push(rules.lineItems.start);
  patterns.push(rules.lineItems.end);
  patterns.push(rules.lineItems.row);
  for (const pattern of Object.values(rules.totals)) {
    patterns.push(pattern);
  }
  return patterns;
}

function literalFraction(pattern: string): number {
  const stripped = pattern.replace(/\\[dDsSwWbBtnrfv.+*?^$|{}()\[\]]/g, "");
  const withoutSyntax = stripped.replace(/[+*?.^$|{}()\[\]\\]/g, "");
  const alphanumOnly = withoutSyntax.replace(/[^a-zA-Z0-9]/g, "");
  return pattern.length > 0 ? alphanumOnly.length / pattern.length : 0;
}

function validateStructure(
  rules: ExtractionRules,
  extraction: LlmExtraction
): ValidationResult {
  const patterns = collectPatterns(rules);
  const literals = collectLiterals(extraction);

  for (const pattern of patterns) {
    try {
      new RE2(pattern);
    } catch (err) {
      return { valid: false, reason: `RE2 incompatible pattern: ${pattern} -- ${err}` };
    }
  }

  for (const literal of literals) {
    for (const pattern of patterns) {
      if (pattern.includes(literal)) {
        return { valid: false, reason: `Pattern contains literal value "${literal}": ${pattern}` };
      }
    }
  }

  const row = rules.lineItems.row;
  const requiredGroups = ["partNumber", "quantity", "unitPrice"];
  for (const group of requiredGroups) {
    if (!row.includes(`(?<${group}>`)) {
      return { valid: false, reason: `Row regex missing named group: ${group}` };
    }
  }

  for (const pattern of patterns) {
    const frac = literalFraction(pattern);
    if (frac > 0.4) {
      return { valid: false, reason: `Pattern is ${Math.round(frac * 100)}% literal: ${pattern}` };
    }
  }

  return { valid: true };
}

function validateExtraction(
  text: string,
  rules: ExtractionRules,
  extraction: LlmExtraction
): ValidationResult {
  const result = applyTemplate(text, rules);

  if (result.items.length < extraction.items.length) {
    return {
      valid: false,
      reason: `Template extracted ${result.items.length} items, LLM extracted ${extraction.items.length}`,
    };
  }

  const templatePNs = new Set(result.items.map((i) => i.partNumber));
  const llmPNs = extraction.items.map((i) => i.partNumber).filter(Boolean);
  for (const pn of llmPNs) {
    if (!templatePNs.has(pn)) {
      return { valid: false, reason: `Template missing part number: ${pn}` };
    }
  }

  for (const llmItem of extraction.items) {
    if (llmItem.unitPrice == null) continue;
    const tplItem = result.items.find((i) => i.partNumber === llmItem.partNumber);
    if (!tplItem || tplItem.unitPrice == null) continue;
    if (Math.abs(tplItem.unitPrice - llmItem.unitPrice) > 0.01) {
      return {
        valid: false,
        reason: `Price mismatch for ${llmItem.partNumber}: template=${tplItem.unitPrice}, llm=${llmItem.unitPrice}`,
      };
    }
  }

  return { valid: true };
}

export function validateTemplate(
  text: string,
  rules: ExtractionRules,
  extraction: LlmExtraction
): ValidationResult {
  const structural = validateStructure(rules, extraction);
  if (!structural.valid) return structural;

  return validateExtraction(text, rules, extraction);
}
```

- [ ] **Step 2: Verify compiles**

```bash
cd backend && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/template-validate.ts
git commit -m "feat: two-phase template validation (structural + extraction)"
```

---

### Task 6: LLM extraction + template generation -- template-llm.ts

**Files:**
- Create: `backend/src/services/template-llm.ts`

- [ ] **Step 1: Create the LLM module**

Create `backend/src/services/template-llm.ts`:

```typescript
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
} as const;

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

export async function llmExtractAndLearn(text: string): Promise<LlmResult> {
  const client = getClient();

  const response = await client.chat.completions.create({
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
      json_schema: RESPONSE_SCHEMA,
    },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty LLM response");

  return JSON.parse(content) as LlmResult;
}
```

- [ ] **Step 2: Verify compiles**

```bash
cd backend && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/template-llm.ts
git commit -m "feat: LLM extraction + template generation via gpt-5.4-nano"
```

---

### Task 7: Vendor detection -- vendor-detect.ts

**Files:**
- Create: `backend/src/services/vendor-detect.ts`

- [ ] **Step 1: Create the vendor detection module**

Create `backend/src/services/vendor-detect.ts`:

```typescript
import { getDb } from "../db/index.js";
import { vendorTemplates } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import type { VendorTemplate, ExtractionRules } from "./template-types.js";

function parseRules(row: typeof vendorTemplates.$inferSelect): VendorTemplate {
  return {
    id: row.id,
    vendorName: row.vendorName,
    vendorDomains: row.vendorDomains ?? [],
    vendorKeywords: row.vendorKeywords ?? [],
    extractionRules: JSON.parse(row.extractionRules) as ExtractionRules,
    successCount: row.successCount,
    failCount: row.failCount,
  };
}

export async function loadAllTemplates(): Promise<VendorTemplate[]> {
  const db = getDb();
  const rows = await db.select().from(vendorTemplates);
  return rows.map(parseRules);
}

export function detectVendor(
  text: string,
  templates: VendorTemplate[]
): VendorTemplate | null {
  const textLower = text.toLowerCase();

  const domainMatches =
    text.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.[a-z]{2,})/gi) || [];
  const textDomains = new Set(
    domainMatches.map((d) =>
      d.replace(/^(?:https?:\/\/)?(?:www\.)?/i, "").toLowerCase()
    )
  );

  // Tier 1: domain match
  for (const tpl of templates) {
    if (tpl.vendorDomains.some((d) => textDomains.has(d.toLowerCase()))) {
      return tpl;
    }
  }

  // Tier 2: keyword match
  for (const tpl of templates) {
    if (tpl.vendorKeywords.some((k) => textLower.includes(k.toLowerCase()))) {
      return tpl;
    }
  }

  return null;
}

export async function incrementSuccess(templateId: number): Promise<void> {
  const db = getDb();
  await db
    .update(vendorTemplates)
    .set({
      successCount: sql`${vendorTemplates.successCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(vendorTemplates.id, templateId));
}

export async function incrementFail(templateId: number): Promise<void> {
  const db = getDb();
  await db
    .update(vendorTemplates)
    .set({
      failCount: sql`${vendorTemplates.failCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(vendorTemplates.id, templateId));
}

export async function upsertTemplate(
  rules: ExtractionRules,
  existingId?: number
): Promise<void> {
  const db = getDb();
  const rulesJson = JSON.stringify(rules);

  if (existingId) {
    await db
      .update(vendorTemplates)
      .set({
        vendorName: rules.vendorName,
        vendorDomains: rules.vendorSignals.domains,
        vendorKeywords: rules.vendorSignals.keywords,
        extractionRules: rulesJson,
        successCount: 0,
        failCount: 0,
        updatedAt: new Date(),
      })
      .where(eq(vendorTemplates.id, existingId));
  } else {
    await db.insert(vendorTemplates).values({
      vendorName: rules.vendorName,
      vendorDomains: rules.vendorSignals.domains,
      vendorKeywords: rules.vendorSignals.keywords,
      extractionRules: rulesJson,
    });
  }
}
```

- [ ] **Step 2: Verify compiles**

```bash
cd backend && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/vendor-detect.ts
git commit -m "feat: vendor detection and template DB operations"
```

---

### Task 8: Rewrite document-parser.ts -- orchestrator

**Files:**
- Rewrite: `backend/src/services/document-parser.ts`

This replaces the entire existing file. It becomes a thin orchestrator.

- [ ] **Step 1: Rewrite document-parser.ts**

Replace the entire contents of `backend/src/services/document-parser.ts` with:

```typescript
import { PDFParse } from "pdf-parse";
import type { DocumentResult, ExtractedItem, StepCallback } from "./template-types.js";
import { applyTemplate, distributeAndNormalize, safeMatch } from "./template-apply.js";
import { validateTemplate } from "./template-validate.js";
import { llmExtractAndLearn, isLlmConfigured } from "./template-llm.js";
import {
  loadAllTemplates,
  detectVendor,
  incrementSuccess,
  incrementFail,
  upsertTemplate,
} from "./vendor-detect.js";

export type { DocumentResult, ExtractedItem };

export async function parseDocument(
  pdfBase64: string,
  onStep: StepCallback = () => {}
): Promise<DocumentResult> {
  // Step 1: Extract text
  onStep("extracting_text", "Extracting text from PDF...");
  const buffer = Buffer.from(pdfBase64, "base64");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  await parser.destroy();

  const text = result.text.replace(/\f/g, "\n").trim();
  if (text.length < 20) {
    throw new Error("Document appears to be empty or image-only");
  }

  // Step 2: Detect vendor
  onStep("detecting_vendor", "Searching for vendor template...");
  const templates = await loadAllTemplates();
  const matched = detectVendor(text, templates);

  if (matched) {
    const isUnreliable =
      matched.failCount > 3 && matched.successCount < matched.failCount;

    if (!isUnreliable) {
      onStep("vendor_matched", `Vendor matched: ${matched.vendorName}`);
      onStep("applying_template", "Applying learned template...");

      const extracted = applyTemplate(text, matched.extractionRules);

      if (extracted.items.length > 0) {
        incrementSuccess(matched.id).catch(() => {});
        onStep("done", `${extracted.items.length} item${extracted.items.length !== 1 ? "s" : ""} extracted`);
        return extracted;
      }

      onStep("template_failed", "Template extraction failed. Falling back to LLM...");
      incrementFail(matched.id).catch(() => {});
    } else {
      onStep("template_failed", `Template for ${matched.vendorName} is unreliable. Using LLM...`);
    }

    return llmPath(text, onStep, matched.id);
  }

  onStep("no_template", "New vendor detected. Learning template via LLM...");
  return llmPath(text, onStep);
}

async function llmPath(
  text: string,
  onStep: StepCallback,
  existingTemplateId?: number
): Promise<DocumentResult> {
  if (!isLlmConfigured()) {
    throw new Error(
      "No extraction template for this vendor. Set OPENAI_API_KEY to enable automatic template learning."
    );
  }

  onStep("llm_extracting", "Sending to gpt-5.4-nano for extraction + template generation...");

  const llmResult = await llmExtractAndLearn(text);

  const items: ExtractedItem[] = llmResult.extraction.items.map((item) => ({
    partNumber: item.partNumber,
    partName: item.partName,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    shipCost: null,
    taxPrice: null,
    brand: item.brand,
  }));

  // Extract totals using the generated template patterns
  let tax = 0;
  let shipping = 0;
  const templateRules = llmResult.template;
  try {
    const taxMatch = templateRules.totals["tax"]
      ? safeMatch(text, templateRules.totals["tax"], "s")
      : null;
    const shipMatch = templateRules.totals["shipping"]
      ? safeMatch(text, templateRules.totals["shipping"], "s")
      : null;
    tax = taxMatch?.[1] ? parseFloat(taxMatch[1]) : 0;
    shipping = shipMatch?.[1] ? parseFloat(shipMatch[1]) : 0;
  } catch {
    // Totals extraction failed
  }

  if ((tax > 0 || shipping > 0) && items.length > 0) {
    distributeAndNormalize(items, shipping, tax);
  }

  const docResult: DocumentResult = {
    vendor: llmResult.extraction.vendor,
    orderNumber: llmResult.extraction.orderNumber,
    orderDate: llmResult.extraction.orderDate,
    technicianName: llmResult.extraction.technicianName,
    trackingNumber: llmResult.extraction.trackingNumber,
    deliveryCourier: llmResult.extraction.deliveryCourier,
    items,
    rawText: text,
  };

  onStep("validating_template", "Validating generated template...");
  const validation = validateTemplate(text, templateRules, llmResult.extraction);

  if (validation.valid) {
    await upsertTemplate(templateRules, existingTemplateId);
    onStep(
      "template_stored",
      "Template learned and stored. Future invoices from this vendor will be instant."
    );
  } else {
    console.warn("Template validation failed:", validation.reason);
    onStep(
      "template_validation_failed",
      "Template validation failed. Using LLM extraction directly."
    );
  }

  onStep("done", `${docResult.items.length} item${docResult.items.length !== 1 ? "s" : ""} extracted`);
  return docResult;
}
```

- [ ] **Step 2: Verify compiles**

```bash
cd backend && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/document-parser.ts
git commit -m "feat: rewrite document parser as adaptive template orchestrator"
```

---

### Task 9: SSE import endpoint -- parts.ts

**Files:**
- Modify: `backend/src/routes/parts.ts:44-70`

- [ ] **Step 1: Replace the import endpoint with SSE version**

Replace lines 44-70 in `backend/src/routes/parts.ts` (the `POST /import` handler) with:

```typescript
// POST /api/parts/import -- extract parts from PDF document (SSE stream)
router.post("/import", requireScope("parts:write"), async (req, res) => {
  const { document } = req.body as { document?: unknown };

  if (typeof document !== "string") {
    res.status(400).json({ error: "document must be a base64 string" });
    return;
  }

  if (document.length > 12 * 1024 * 1024) {
    res.status(400).json({ error: "document exceeds 12MB limit" });
    return;
  }

  // Switch to SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const steps: Array<{ step: string; message: string }> = [];

  function sendStep(step: string, message: string) {
    steps.push({ step, message });
    res.write(`event: step\ndata: ${JSON.stringify({ step, message })}\n\n`);
  }

  try {
    const result = await parseDocument(document, sendStep);
    res.write(`event: result\ndata: ${JSON.stringify({ ...result, steps })}\n\n`);
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to parse document";
    res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
    res.end();
  }
});
```

- [ ] **Step 2: Verify compiles**

```bash
cd backend && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/parts.ts
git commit -m "feat: SSE streaming for document import endpoint"
```

---

### Task 10: Export refreshAccessToken from client.ts

**Files:**
- Modify: `frontend/src/api/client.ts:15`

- [ ] **Step 1: Make refreshAccessToken public**

In `frontend/src/api/client.ts`, change line 15 from:

```typescript
async function refreshAccessToken(): Promise<string | null> {
```

to:

```typescript
export async function refreshAccessToken(): Promise<string | null> {
```

- [ ] **Step 2: Verify compiles**

```bash
cd frontend && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/client.ts
git commit -m "feat: export refreshAccessToken for SSE auth"
```

---

### Task 11: Frontend SSE import page -- ImportDocument.tsx

**Files:**
- Rewrite: `frontend/src/pages/ImportDocument.tsx`

- [ ] **Step 1: Rewrite ImportDocument.tsx with SSE + live steps**

Replace the entire contents of `frontend/src/pages/ImportDocument.tsx` with:

```tsx
import { useState, useRef, type ChangeEvent, type DragEvent } from "react";
import { getAccessToken, refreshAccessToken } from "../api/client";
import { Icon } from "../components/Icon";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

interface ExtractedItem {
  partNumber: string;
  partName: string;
  quantity: number;
  unitPrice: number | null;
  shipCost: number | null;
  taxPrice: number | null;
  brand: string | null;
}

interface ParseResult {
  vendor: string;
  orderNumber: string | null;
  orderDate: string | null;
  technicianName: string | null;
  trackingNumber: string | null;
  deliveryCourier: string | null;
  items: ExtractedItem[];
  rawText: string;
  steps: Array<{ step: string; message: string }>;
}

interface StepEntry {
  step: string;
  message: string;
  status: "active" | "done";
}

function fmt(v: number | null): string {
  return v != null ? `$${v.toFixed(2)}` : "-";
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value && value !== "") return null;
  return (
    <tr>
      <td className="pr-4 py-1 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap align-top">{label}</td>
      <td className="py-1 text-sm text-gray-900 dark:text-gray-100 break-words">{value || "-"}</td>
    </tr>
  );
}

export function ImportDocument() {
  const [result, setResult] = useState<ParseResult | null>(null);
  const [steps, setSteps] = useState<StepEntry[]>([]);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  async function processFile(file: File) {
    setError("");
    setParsing(true);
    setResult(null);
    setSteps([]);

    try {
      const base64 = await fileToBase64(file);
      const body = JSON.stringify({ document: base64 });

      async function doRequest(token: string): Promise<Response> {
        return fetch("/api/parts/import", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body,
        });
      }

      let token = getAccessToken();
      if (!token) throw new Error("Not authenticated");

      let response = await doRequest(token);

      if (response.status === 401) {
        const newToken = await refreshAccessToken();
        if (!newToken) throw new Error("Session expired");
        response = await doRequest(newToken);
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: "Import failed" }));
        throw new Error(err.error || `HTTP ${response.status}`);
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const chunks = buffer.split("\n\n");
        buffer = chunks.pop()!;

        for (const chunk of chunks) {
          if (!chunk.trim()) continue;
          const typeMatch = chunk.match(/^event:\s*(\w+)/m);
          const dataMatch = chunk.match(/^data:\s*(.+)$/m);
          if (!typeMatch || !dataMatch) continue;

          const eventType = typeMatch[1];
          const data = JSON.parse(dataMatch[1]);

          if (eventType === "step") {
            setSteps((prev) => {
              const updated = prev.map((s) =>
                s.status === "active" ? { ...s, status: "done" as const } : s
              );
              return [...updated, { step: data.step, message: data.message, status: "active" as const }];
            });
          } else if (eventType === "result") {
            setSteps((prev) => prev.map((s) => ({ ...s, status: "done" as const })));
            setResult(data as ParseResult);
          } else if (eventType === "error") {
            throw new Error(data.error);
          }
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to parse document");
    } finally {
      setParsing(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  }

  function onDragEnter(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) setDragging(true);
  }
  function onDragOver(e: DragEvent) { e.preventDefault(); e.stopPropagation(); }
  function onDragLeave(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setDragging(false);
    const file = Array.from(e.dataTransfer.files).find(
      (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")
    );
    if (file) processFile(file);
  }

  function reset() {
    setResult(null);
    setSteps([]);
    setError("");
  }

  const showUpload = !result && !parsing && steps.length === 0;

  return (
    <div className="pt-4">
      <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-4">
        Import Document
      </h1>

      {error && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-xs text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {steps.length > 0 && (
        <div className="mb-4 space-y-1">
          {steps.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
              {s.status === "active" ? (
                <Icon name="hourglass_top" size={14} className="animate-spin text-gray-400" />
              ) : (
                <Icon name="check_circle" size={14} className="text-green-500" />
              )}
              <span>{s.message}</span>
            </div>
          ))}
        </div>
      )}

      {showUpload && (
        <label
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={`flex flex-col items-center justify-center gap-2 px-4 py-10 rounded-lg border-2 border-dashed cursor-pointer transition-colors ${
            dragging
              ? "border-gray-900 dark:border-gray-100 bg-gray-50 dark:bg-gray-800"
              : "border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500"
          }`}
        >
          <Icon name="upload_file" size={32} className="text-gray-400 dark:text-gray-500" />
          <span className="text-sm text-gray-600 dark:text-gray-300">
            Select a PDF document
          </span>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,application/pdf"
            className="sr-only"
            onChange={handleFile}
          />
        </label>
      )}

      {result && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {result.items.length} item{result.items.length !== 1 ? "s" : ""} extracted
            </span>
            <button
              type="button"
              onClick={reset}
              className="p-2 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
              title="Upload different document"
            >
              <Icon name="refresh" size={18} />
            </button>
          </div>

          {result.items.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No items found in this document.
            </p>
          )}

          {result.items.map((item, i) => (
            <table key={i} className="w-full border-collapse">
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {result.items.length > 1 && (
                  <tr>
                    <td colSpan={2} className="py-1 text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">
                      Item {i + 1}
                    </td>
                  </tr>
                )}
                <Row label="Technician" value={result.technicianName} />
                <Row label="Part Name" value={item.partName} />
                <Row label="Part Number" value={item.partNumber || "-"} />
                <Row label="Brand" value={item.brand} />
                <Row label="Unit Price" value={fmt(item.unitPrice)} />
                <Row label="Ship Cost" value={fmt(item.shipCost)} />
                <Row label="Tax" value={fmt(item.taxPrice)} />
                <Row label="Total" value={fmt(
                  (item.unitPrice ?? 0) + (item.shipCost ?? 0) + (item.taxPrice ?? 0)
                )} />
                <Row label="Quantity" value={String(item.quantity)} />
                <Row label="Order Number" value={result.orderNumber} />
                <Row label="Tracking" value={result.trackingNumber} />
                <Row label="Courier" value={result.deliveryCourier} />
                <Row label="Order Date" value={result.orderDate} />
                <Row label="Vendor" value={result.vendor} />
              </tbody>
            </table>
          ))}

          <details className="text-xs">
            <summary className="text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300">
              Raw text
            </summary>
            <pre className="mt-2 p-3 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
              {result.rawText}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify compiles**

```bash
cd frontend && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/ImportDocument.tsx
git commit -m "feat: SSE-driven import page with live processing steps"
```

---

### Task 12: Build verification

**Files:** None (verification only)

- [ ] **Step 1: Build backend**

```bash
cd backend && npx tsc -b
```

Expected: clean build, no errors.

- [ ] **Step 2: Build frontend**

```bash
cd frontend && npx tsc --noEmit && npm run build
```

Expected: clean build, no errors.

- [ ] **Step 3: Commit any fixups**

If any build errors needed fixing, commit them:

```bash
git add -A
git commit -m "fix: build fixups for adaptive parser"
```
