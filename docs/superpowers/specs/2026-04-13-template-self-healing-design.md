# Template Self-Healing Design Spec

## Overview

Replace the current single-template-per-vendor system with versioned templates that self-heal when they break. Templates are validated via a multi-check validation stack on every extraction, repaired or regenerated automatically when they fail, and evicted when they stop working.

Also introduces text preprocessing (boilerplate stripping), description quality gates at template creation, and a learned prefix system that improves sanitization over time from real document data.

## Goals

- Templates should fix themselves when vendor invoice layouts change
- Support vendors with multiple document formats (quotes, invoices, credit memos)
- Reduce LLM token usage by stripping corporate boilerplate before all LLM calls
- Simplify template generation by using GPT 5.4 directly instead of mini+repair+Gemini chain
- User always gets a result fast -- repair/regeneration happens in the background
- Catch and reject templates that overcapture into descriptions at creation time
- Learn junk prefixes from real documents to improve sanitization over time

## Non-goals (v1)

- Template versioning UI (backend only, no user-facing version management)
- Automatic template sharing across instances
- Handling exotic document types (credit memos with negative values, tax-inclusive pricing, bundle lines) -- these fall through to nano extraction

---

## 1. Text Preprocessing

A `stripBoilerplate(text: string): string` function runs after pdf-parse (and OCR supplement if triggered). **Stripped text is used only for LLM calls.** Template regex matching, vendor detection, and math-check subtotal parsing all run against the original raw text. This prevents stripping from removing anchors that templates depend on.

### Two text tracks

- `rawText` -- original pdf-parse + OCR output. Used for: vendor detection, template regex application, subtotal/total parsing (`recoverTotals`), stored on `DocumentResult`
- `cleanText` -- after `stripBoilerplate`. Used for: all LLM calls (extraction, fill-in, template generation)

### Universal strip rules (applied to produce cleanText)

**Legal prose:** Lines > 80 characters that contain none of:
- Dollar amounts (`$X.XX` or `X.XX` adjacent to financial context)
- Date patterns (`MM/DD/YYYY`, `YYYY-MM-DD`, month names)
- Key:value structure (word(s) followed by `:` then a short value)

**Known boilerplate section headers** -- when matched, skip all lines until the next blank line or new section header:
- `TERMS:`, `RETURNS:`, `WARRANTY:`, `Return Policy:`
- `Remit to`, `ACH`, `Wire Info`

**Payment confirmation lines:** Lines matching `VISA|Mastercard|MasterCard|Amex|PayPal|payment` paired with dollar amounts. These are payment method confirmations, not order data. The template's `extractRows` already skips these via `/payment/i`, but stripping them saves tokens on LLM calls too.

**Page markers:** `-- N of N --`, `Page N of N`, `Page N`

**Corporate contact blocks:** Consecutive lines containing phone numbers (`(NNN) NNN-NNNN`), fax numbers, `www.`, `Website`, `Telephone` -- but NOT lines that follow a `Ship To:` or `Deliver To:` header (those are useful shipping addresses).

**OCR dedup:** If the text contains the `--- OCR-enhanced text ---` separator, compare lines in the OCR section against lines in the pdf-parse section. Strip OCR lines that are exact or near-exact matches (after normalizing whitespace) of pdf-parse lines. This prevents duplicate addresses, headers, and metadata from inflating the text.

### Fill-in strip (template path only)

Applied to cleanText before sending to the nano fill-in call. Removes content the template already handles:

- **Item rows:** Lines that matched the template's row regex (the template extracted these)
- **Addresses:** Multi-line address blocks (street + city/state/zip patterns) EXCEPT the ship-to recipient name (the line immediately after `Ship To:`)

What survives: order number, date, tracking number, courier, ship-to name, subtotal/tax/shipping/total lines. Typically 200-400 chars.

---

## 2. Data Model

### `vendor_templates` table changes

The current schema has a `UNIQUE` constraint on `vendor_key`, and `upsertTemplate` uses `ON CONFLICT (vendor_key) DO UPDATE`. This must change to support multiple versions per vendor.

**Migration:**

1. Drop the existing unique constraint on `vendor_key`
2. Add new columns
3. Add new unique constraint on `(vendor_key, version)`

New columns:

| Column | Type | Default | Purpose |
|---|---|---|---|
| `version` | integer, NOT NULL | 1 | Version number per vendor_key, increments on regeneration |
| `recent_results` | jsonb, NOT NULL | '[]' | Rolling window of last 10 extraction results: `[{ "pass": true, "ts": "ISO8601" }, ...]` |
| `status` | text, NOT NULL | 'active' | 'active' or 'dead' |

Existing columns retained as-is: `id`, `vendor_key`, `vendor_name`, `vendor_domains`, `vendor_keywords`, `extraction_rules`, `success_count`, `fail_count`, `last_generation_attempt`, `created_at`, `updated_at`.

`success_count` and `fail_count` remain as lifetime counters for observability. `recent_results` is the rolling window used for eviction decisions.

### `learned_prefixes` table (new)

Stores junk prefixes learned from nano comparisons. Global, not per-vendor -- "SHIPPED" is "SHIPPED" regardless of who sends the invoice.

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `prefix` | text, NOT NULL, UNIQUE | The prefix string (e.g., "SHIPPED", "BACKORDERED") |
| `source_vendor` | text, NOT NULL | Which vendor's document first taught us this prefix |
| `hit_count` | integer, NOT NULL, default 1 | How many times this prefix has been stripped across all documents |
| `created_at` | timestamp, NOT NULL | When first learned |

### Write path changes

**`upsertTemplate` is removed.** Replaced by one operation:

- `createTemplateVersion(vendorKey, rules)` -- inserts a new row. Serialized via Postgres advisory lock:

```sql
BEGIN
  SELECT pg_advisory_xact_lock(hashtext($vendorKey))  -- lock scoped to this vendor
  SELECT coalesce(max(version), 0) FROM vendor_templates WHERE vendor_key = $1
  INSERT INTO vendor_templates (..., version = max + 1)
  -- cap enforcement inline (see section 5)
COMMIT  -- advisory lock auto-releases
```

`pg_advisory_xact_lock(hashtext(vendorKey))` acquires a transaction-scoped advisory lock keyed to the vendor. This serializes all version creation for the same vendor, including the first insert (where no rows exist yet and `FOR UPDATE` would lock nothing). The unique constraint on `(vendor_key, version)` is a safety net -- if the advisory lock somehow fails to serialize, the insert errors instead of creating duplicates.

`updateTemplateRules` is removed. All template creation goes through `createTemplateVersion`, including initial learning. This eliminates the risk of mutating a version that has scored history. A template row is immutable once created -- only `recent_results`, `success_count`, `fail_count`, and `status` are updated.

### Matching logic change

Current: `detectVendor` returns one `VendorMatch`.
New: `detectVendor` returns all active templates for the matched vendor, ordered by `version DESC` (newest first). The extraction flow tries each version in order. The vendor detection itself (domain/keyword matching) uses `rawText` and is unchanged -- it just returns multiple templates instead of one.

---

## 3. Extraction Flow

### Full flow for template mode

```
PDF
 -> pdf-parse
 -> OCR supplement (if quality issues detected)
 -> rawText (preserved for template matching, vendor detection, subtotal parsing)
 -> cleanText = stripBoilerplate(rawText)

 -> Vendor match on rawText (find all active templates, newest first)

 -> For each template version:
      Apply regex to rawText -> get items
      Sanity check (not scored): zero items or empty part numbers?
        YES -> skip to next version
        NO  -> Validation (scored, see below)
          PASS -> record success, fill-in strip, nano fill-in, sanitize (with learned prefixes), serve result
          FAIL -> record fail, try next version

 -> All versions failed (or no template exists):
      Full nano extraction (cleanText, up to 10K chars) -> serve to user
      Background: analyze failure, repair or regenerate (see section 4)
      Background: diff nano vs template descriptions, learn new prefixes (see section 7)

 -> Eviction check (see section 5)
```

### Validation stack

Checks run in order on every template extraction that produces items. Document type is detected **first** because it modifies the behavior of subsequent checks.

**Step 0: Document type detection (runs before all checks)**

Lightweight regex scan of rawText. Detected once, passed to all checks.

```
docType = detectDocType(rawText)
  "credit"   -> "credit memo", "credit note", "return authorization", or negative total
  "quote"    -> "quote", "estimate", "quotation", "not an invoice"
  "invoice"  -> default (everything else)
```

**Check 1: Row count sanity**
```
items.length > 0                          // already handled by sanity pre-check
items.every(i => i.partNumber.length > 0) // no empty part numbers
items.every(i => i.quantity > 0)          // no zero/negative quantities
if docType != "credit":
  items.every(i => i.unitPrice == null || i.unitPrice >= 0)  // no negative prices
// credit memos: negative prices are expected, skip this check
```
Failure = not scored, skip to next version (same as zero items).

**Check 2: Part number coverage**
```
textPartNumbers = findPartNumbers(rawText)  // existing regex function
templatePartNumbers = Set(items.map(i => i.partNumber))
```

When `findPartNumbers` returns results, coverage is meaningful:
```
overlap = templatePartNumbers intersect textPartNumbers
coverage = overlap.size / textPartNumbers.size
coveragePass = coverage >= 0.8
```

When `findPartNumbers` returns empty (vendor uses SKU formats outside the appliance-part regex library), coverage is **indeterminate** -- treated the same as missing subtotal. The check doesn't pass or fail; it's skipped. This prevents false failures on vendors with non-standard part number formats and false passes on vendors where the regex library is incomplete.

Discount/coupon lines (part number matches `DISCOUNT`, `COUPON`, `PROMO`, or starts with `-$`) are excluded from the coverage denominator (they won't appear in `findPartNumbers`) but included in math check (they affect the subtotal).

**Check 3: Math check**
```
subtotal = parseSubtotalFromText(rawText)  // regex on rawText, no LLM
computed = sum(item.unitPrice * item.quantity) for all extracted items
if docType == "credit":
  computed = abs(computed)  // credit memos may have negative line items
  subtotal = abs(subtotal)
mathPass = subtotal != null && abs(computed - subtotal) < 0.01
```

For quotes/estimates (`docType == "quote"`): subtotal may not exist. If it does, run the check normally. If it doesn't, math is indeterminate (not pass, not fail).

**Combined scoring:**
- Row sanity fails -> not scored, skip version
- Coverage available and fails -> scored as **fail**
- Math available and fails -> scored as **fail**
- Math passes + coverage passes -> scored as **pass**
- Math passes + coverage indeterminate -> scored as **pass** (math is the stronger signal)
- Math indeterminate + coverage passes -> scored as **unverified**
- Both indeterminate -> scored as **unverified**

### Unverified extractions

When neither math nor coverage can produce a definitive result, the extraction is served but scored as "unverified" in `recent_results`: `{ "pass": null, "ts": "..." }`.

Unverified results don't count toward pass OR fail for eviction purposes. But if a template accumulates 5+ consecutive unverified results with zero verified passes, it triggers a **spot-check**.

**Spot-check runs inline on the request path**, not in the background. This adds a full nano extraction call that wouldn't otherwise happen -- extra cost and latency compared to the normal template path. The tradeoff is acceptable because:
- Spot-checks are rare (only after 5+ consecutive unverified results)
- The alternative is serving a potentially bad result and only discovering it later
- Nano fill-in and nano full-extraction run concurrently, so latency is the slower of the two (not additive)
- If nano agrees with the template, serve the template result. If not, serve nano's result instead.

After the spot-check: if nano agrees, record a verified pass. If not, record a fail and trigger background repair/regeneration.

### Post-extraction sanitization

After any extraction (template or LLM), `sanitizeExtraction()` runs. This includes:

- **Learned prefix stripping:** Load all prefixes from `learned_prefixes` table (cached in memory, refreshed periodically). For each item's `partName`, check if it starts with any learned prefix. If so, strip it and increment `hit_count`.
- **Hardcoded prefix stripping:** Static list of known status prefixes as fallback (`SHIPPED`, `B/O`, `BACKORDERED`, `IN STOCK`, `OUT OF STOCK`, `PENDING`, `ON ORDER`). These are the seed list -- learned prefixes extend it over time.
- Existing sanitization rules (tracking number validation, courier validation, brand validation) continue unchanged.

The hardcoded list is the safety net. The learned list is the intelligence. Together they cover known patterns and adapt to new ones.

### Nano fill-in (template success path)

When a template passes validation:

1. Apply fill-in strip to cleanText (remove item rows and addresses)
2. Send stripped text (~200-400 chars) to nano with the existing `FILL_IN_SCHEMA` (7 metadata fields)
3. Run `recoverTotals` on rawText as backup for tax/shipping
4. Distribute tax/shipping to items via `distributeAndNormalize`
5. Run `fixSplitTracking` and `sanitizeExtraction` (including learned prefix stripping)

### Nano full extraction (fallback path)

When all template versions fail:

1. Send cleanText (up to 10K chars) to nano with `EXTRACTION_SCHEMA` (items + metadata)
2. Run `recoverTotals`, `distributeAndNormalize`, `fixSplitTracking`, `sanitizeExtraction`
3. Serve result to user
4. Trigger background repair/regeneration (section 4)

---

## 4. Background Repair & Regeneration

After serving the nano fallback result, analyze why each template version failed and take action.

### Determining repair vs regeneration

Diff the nano extraction against each failed template's output:

**Same items, wrong values (field-level failure):**
- Template and nano found the same part numbers
- But prices, quantities, or descriptions differ
- Action: **targeted repair** -- create a new version with the fixed capture group

**Wrong items (structural failure):**
- Template found different part numbers than nano, or found zero items
- The start/end/row structure is broken
- Action: **regenerate** a new template version from scratch

### Confidence gate for repairs

Nano is probabilistic -- it can be wrong. Before using nano output to repair or regenerate a template, it must pass a confidence gate. The gate adapts to what's available in the document:

**Tier 1 (strongest): Math confirms nano.**
Nano's `sum(unitPrice * qty)` matches the document subtotal. This is the preferred gate. If nano passes math, it's trustworthy as ground truth.

**Tier 2 (moderate): Part number agreement without math.**
Subtotal is absent (quote, estimate, or unlabeled doc), but nano's part numbers have high overlap with `findPartNumbers(rawText)` (>= 80% coverage). Nano is probably right about which items exist, even if we can't verify prices. In this case:
- Regeneration is allowed (we trust nano's structural understanding of the doc)
- Targeted field repair of prices is NOT allowed (no math to confirm the price is correct)
- Targeted field repair of part numbers/quantities IS allowed (coverage confirms these)

**Tier 3 (no confidence): Neither math nor coverage available.**
No subtotal and `findPartNumbers` returns nothing useful. Don't repair or regenerate. Just record the fail. The template's health stats degrade naturally, and if it keeps failing, eviction handles it.

This ensures quotes and estimates can still trigger self-healing (via tier 2) without requiring a subtotal that doesn't exist.

### Targeted repair

Creates a **new template version** (not in-place update). The new version:
- Copies all rules from the failing version
- Fixes the specific broken capture group
- Starts with empty `recent_results` and zero success/fail counts
- The old version retains its history intact for auditing

Repair process:
1. Send GPT 5.4 the broken capture group, the expected values (from nano), and the raw text context around the failing rows
2. Validate the repaired template using the same confidence tier that authorized the repair (see confidence gate above). Tier 1: math + nano cross-check. Tier 2: nano part number cross-check only (no math required).
3. If valid, save as new version
4. If invalid, record `last_generation_attempt`, 7-day cooldown

### Regeneration

Send GPT 5.4 the cleanText + nano's extraction (as reference, not to hardcode). Generate new template from scratch.

Validate using the same confidence tier that authorized the regeneration. Tier 1: math + nano cross-check. Tier 2: nano part number cross-check only. If valid:
- Save as a new version via `createTemplateVersion` (inside transaction, see section 2)
- Cap enforcement runs after (section 5)

If validation fails:
- Record `last_generation_attempt` on the vendor
- 7-day cooldown before retrying

### No retry chain

GPT 5.4 gets one shot. No repair attempt on the regenerated template, no escalation to another model. If 5.4 can't produce a valid template for this layout, it's too complex for regex.

---

## 5. Eviction Rules & Transaction Boundaries

### Transaction requirements

All template state mutations must be transactional to prevent concurrent background jobs from corrupting state:

**Recording results:** `UPDATE vendor_templates SET recent_results = ... WHERE id = $1` -- single row update, inherently atomic.

**Version creation + cap enforcement:** These MUST happen in one transaction with an advisory lock:
```sql
BEGIN
  SELECT pg_advisory_xact_lock(hashtext($vendorKey))  -- vendor-scoped lock
  SELECT coalesce(max(version), 0) FROM vendor_templates WHERE vendor_key = $1
  INSERT INTO vendor_templates (..., version = max + 1)
  -- cap enforcement: if count(active versions for vendor_key) > 3, mark weakest as dead
COMMIT  -- advisory lock auto-releases
```
The advisory lock serializes all version creation for the same vendor, including the first insert where no rows exist yet. The unique constraint on `(vendor_key, version)` is a safety net. Cap enforcement runs inside the same transaction so it sees the just-inserted version.

**Eviction (dead check):** Runs after recording a result. Single-row update (`SET status = 'dead' WHERE id = $1`), inherently atomic. No transaction needed beyond the implicit one.

### Eviction logic

**Minimum sample size:** No eviction decisions until a version has at least 5 scored results (pass or fail) in `recent_results`. Unverified results (`pass: null`) don't count toward the minimum. A version with 1 fail out of 1 attempt is untested, not dead.

**Dead check:** If a template version has 5+ scored results and 0 passes among them, mark `status = 'dead'`. Dead templates are never tried again.

**Cap enforcement:** If a vendor has more than 3 active versions, evict the weakest. Weakness is determined by pass rate, weighted by sample size: a version with 8/10 passes (80%, high confidence) beats a version with 1/1 pass (100%, no confidence). Specifically: `score = passes / scored_results` with a minimum of 5 scored results required. Versions below the minimum are considered weaker than any version above it, regardless of their raw pass rate.

Dead templates remain in the database for auditing but are excluded from `detectVendor` queries.

---

## 6. Template Generation & Validation

### Model change

Replace the current 3-model chain:
- ~~gpt-5.4-mini generate -> gpt-5.4-mini repair -> Gemini 2.5 Flash escalation~~
- **GPT 5.4 single-shot generation**

### Validation at creation time

All generated/repaired templates are validated before saving. Validation uses the same confidence tier system as the repair/regeneration that triggered it (section 4).

**Tier 1 (subtotal available):** All gates must pass:
1. **Part number gate:** Template's extracted part numbers must match nano's.
2. **Quantity gate:** Quantities must match.
3. **Description gate:** For each matched part, tokenize both nano's and template's partName (split on whitespace, lowercase, strip punctuation). Require 80%+ token overlap (intersection / nano token count). Template's partName must not be >30% longer than nano's by character count. This catches overcapture -- e.g., template grabbing "SHIPPED IGNITOR SVCE" when nano says "IGNITOR SVCE" -- while tolerating word reordering and abbreviation differences (e.g., nano "IGNITOR SVCE" vs template "SERVICE IGNITOR"). The template is rejected, not repaired.
4. **Price gate:** Prices must match within $0.01 per item.
5. **Math gate:** `sum(unitPrice * qty)` must match subtotal within $0.01.

**Tier 2 (no subtotal -- quotes/estimates):** Nano cross-check only:
1. **Part number gate:** Same as tier 1.
2. **Quantity gate:** Same as tier 1.
3. **Description gate:** Same as tier 1.
4. Prices are NOT validated (no math to confirm correctness).

Tier 3 (no confidence) never reaches validation -- the confidence gate blocks repair/regeneration entirely.

### Why descriptions are checked at creation, not runtime

The description gate ensures the template regex never saves a `(?<description>...)` group that captures shipment status columns, metadata fields, or other junk. This is caught once, at creation time. If GPT 5.4 can't produce a clean regex, the template isn't saved and the vendor stays on nano extraction until the next attempt.

The runtime sanitizer (section 7) is the safety net for edge cases: older templates created before this check existed, or LLM-only extraction where nano itself gets it wrong.

### Cost analysis

Template generation is a one-time cost per vendor version. At ~3K input tokens + ~100 output tokens:
- GPT 5.4: ~$0.009 per generation
- Previous chain (worst case): ~$0.002

The $0.007 difference is negligible. A single template that works saves ~$0.001 per document on LLM extraction costs. Pays for itself after ~9 documents from that vendor.

---

## 7. Learned Prefix System

### Concept

Every time the system has both a template extraction and a nano extraction for the same document (during template creation, background repair/regeneration, or spot-checks), it compares `partName` values for matching part numbers. If the template's partName has extra text at the start that nano didn't include, that extra text is a candidate prefix.

Over time, this builds a global list of junk prefixes that the runtime sanitizer uses to clean up future extractions without needing nano.

### Learning flow

```
Template extracts: partName = "SHIPPED IGNITOR SVCE"
Nano extracts:     partName = "IGNITOR SVCE"

Diff: template starts with "SHIPPED " that nano doesn't have
      "SHIPPED" is a single word, all-caps -> likely a status field

-> INSERT INTO learned_prefixes (prefix, source_vendor) VALUES ('SHIPPED', 'wcpdistributing.com')
   ON CONFLICT (prefix) DO UPDATE SET hit_count = hit_count + 1
```

### Prefix candidacy rules

Not every difference is a learnable prefix. Filter candidates:
- Must be at the **start** of partName (prefix, not suffix or middle)
- Must be a single word or known multi-word pattern (e.g., "IN STOCK", "OUT OF STOCK")
- Must be all-uppercase (mixed case is more likely to be part of the real description)
- Must not contain digits (part numbers and model codes often start descriptions)
- Must be 2-15 characters (too short = noise, too long = probably real description text)
- Must not be a known brand name (from `BRAND_PATTERN`)

### Runtime usage

`sanitizeExtraction()` loads all **activated** learned prefixes (cached in memory with a TTL, e.g., 5 minutes). A prefix is activated when `hit_count >= 3` -- meaning at least 3 independent observations confirmed it. Combined with the hardcoded list, it builds a regex:

```
/^(SHIPPED|B\/O|BACKORDERED|IN\s*STOCK|...|<learned1>|<learned2>)\s+/i
```

This regex runs on every `item.partName` regardless of extraction path (template or LLM). If a prefix is stripped, `hit_count` is incremented in a batched background write (accumulated in memory, flushed every 5 minutes or on process shutdown) to avoid per-item write amplification.

### When learning happens

Prefix learning only happens when we have both template output and nano output for the same document. This occurs during:

1. **Template creation** -- GPT 5.4 generates a template, we validate against nano. If descriptions differ, insert/increment the candidate prefix.
2. **Background repair/regeneration** -- template failed, nano extracted as fallback. Diff descriptions for each matched part number.
3. **Spot-checks** -- unverified template triggered a nano comparison. Diff descriptions.

Learning does NOT happen on the normal success path (no nano output to compare against). This is intentional -- no extra LLM calls for learning.

**Activation threshold:** A newly learned prefix starts with `hit_count = 1` and is inert -- it is NOT used in runtime sanitization. Only when `hit_count >= 3` (confirmed by 3 independent observations across potentially different vendors/documents) does the prefix become active and join the runtime regex. This prevents a single bad nano comparison from poisoning global sanitization.

### Hit count and cleanup

`hit_count` serves two purposes:
- **Activation gate:** Prefixes with `hit_count < 3` are inert (not used in runtime sanitization). This means a single bad observation can never affect extractions.
- **Confidence signal:** A prefix with `hit_count > 10` is definitely real. Prefixes with `hit_count < 3` that are older than 90 days could be pruned (future optimization, not v1).

---

## 8. Migration

### Database migration

```sql
-- Step 1: Drop old unique constraint on vendor_key
ALTER TABLE vendor_templates DROP CONSTRAINT vendor_templates_vendor_key_unique;

-- Step 2: Add new columns
ALTER TABLE vendor_templates
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN recent_results jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN status text NOT NULL DEFAULT 'active';

-- Step 3: Add new unique constraint
ALTER TABLE vendor_templates
  ADD CONSTRAINT vendor_templates_vendor_key_version_unique
  UNIQUE (vendor_key, version);

-- Step 4: Index for loading active templates per vendor
CREATE INDEX idx_vendor_templates_status ON vendor_templates (vendor_key, status, version DESC);

-- Step 5: Learned prefixes table
CREATE TABLE learned_prefixes (
  id serial PRIMARY KEY,
  prefix text NOT NULL UNIQUE,
  source_vendor text NOT NULL,
  hit_count integer NOT NULL DEFAULT 1,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Step 6: Seed with known prefixes
INSERT INTO learned_prefixes (prefix, source_vendor) VALUES
  ('SHIPPED', 'seed'),
  ('BACKORDERED', 'seed'),
  ('BACK ORDERED', 'seed'),
  ('IN STOCK', 'seed'),
  ('OUT OF STOCK', 'seed'),
  ('PENDING', 'seed'),
  ('ON ORDER', 'seed');
```

Note: `created_at` already exists on vendor_templates. Existing templates get `version = 1`, `status = 'active'`, empty `recent_results` (neutral starting point -- they'll build up history naturally).

### Code changes

1. **New:** `text-preprocessing.ts` -- `stripBoilerplate` function + fill-in strip logic
2. **New:** `validation-stack.ts` -- `detectDocType`, `parseSubtotal`, `validateExtraction`
3. **New:** `template-lifecycle.ts` -- `createTemplateVersion` (advisory lock), `recordResult`, eviction logic, `needsSpotCheck`
4. **New:** `learned-prefixes.ts` -- `loadLearnedPrefixes` (cached), `learnPrefix`, `stripLearnedPrefixes`
5. **Modified:** `document-parser.ts` -- two text tracks (rawText/cleanText), version loop, validation stack, spot-check, background repair/regen, learned prefix stripping in sanitizer, prefix learning during nano comparisons
6. **Modified:** `template-llm.ts` -- replace `TEMPLATE_MODEL` with GPT 5.4, remove Gemini, add `llmRepairField`
7. **Modified:** `template-validate.ts` -- tiered validation with description gate: tier 1 (math + nano + descriptions), tier 2 (nano part numbers + quantities + descriptions only)
8. **Modified:** `vendor-detect.ts` -- return all active versions per vendor, replace `upsertTemplate` with `createTemplateVersion` (transactional with advisory lock)
9. **Modified:** `db/schema.ts` -- drop unique on vendor_key, add version/recent_results/status columns, add learned_prefixes table
10. **Modified:** `routes/vendor-templates.ts` -- add version and status to GET response

### Removed

- `llmRepairRowRegex` function (replaced by targeted field repair via GPT 5.4)
- `ESCALATION_MODEL` constant and Gemini client setup
- `verifyTemplateInBackground` function (replaced by validation on every extraction)
- `upsertTemplate` function (replaced by `createTemplateVersion`; template rows are immutable once created)
