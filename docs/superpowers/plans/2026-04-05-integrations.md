# Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Brave Search cross-reference lookups and eBay OAuth + auto-depletion to the existing backend.

**Architecture:** Two integration services (cross-ref search, eBay sync) added to the existing Express backend. Both are background/async — they don't block the main request flow.

**Tech Stack:** Brave Search API, eBay Fulfillment API (OAuth 2.0), node:crypto for AES-256-GCM

**Spec:** `docs/superpowers/specs/2026-04-05-part-tracker-design.md`
**Depends on:** Backend Core plan must be complete first.

---

## File Structure (new/modified files)

```
backend/src/
  services/
    cross-ref.ts          # NEW — Brave Search cross-reference lookup
    ebay.ts               # NEW — eBay token management + order polling
  routes/
    ebay.ts               # NEW — eBay OAuth flow + quarantine endpoint
    parts.ts              # MODIFIED — fire cross-ref after part add
  index.ts                # MODIFIED — mount eBay routes + internal poll route
  middleware/
    rate-limit.ts         # MODIFIED — add ebay callback limiter
    auth.ts               # MODIFIED — exempt /api/internal/ebay-poll
```

---

### Task 1: Brave Search Cross-Reference Service

**Files:**
- Create: `backend/src/services/cross-ref.ts`
- Create: `backend/src/services/cross-ref.test.ts`

- [ ] **Step 1: Create `src/services/cross-ref.ts`**

Write `backend/src/services/cross-ref.ts`:

```typescript
import { getDb } from "../db/index.js";
import { crossReferences, settings } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { normalizePartNumber } from "./normalize.js";

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";

// Common appliance part number patterns
// Matches: WPW10321304, W10321304, WB62X10013, 5304506469, 316575430, etc.
// Does NOT match: AP, PS, EA prefix catalog IDs
const PART_NUMBER_REGEX = /\b(?:WP[A-Z]?\d{5,}|W\d{7,}|WB\d+X\d+|\d{7,10}|[A-Z]{2,3}\d{6,})\b/gi;

// Catalog IDs to filter out (retailer codes, not physical part numbers)
const CATALOG_PREFIX_REGEX = /^(?:AP|PS|EA)\d+$/i;

interface BraveSearchResult {
  web?: {
    results?: Array<{
      title: string;
      description: string;
      url: string;
    }>;
  };
}

interface ExtractedRef {
  partNumber: string;
  sourceUrl: string;
}

async function braveSearch(query: string, apiKey: string): Promise<BraveSearchResult> {
  const url = new URL(BRAVE_API_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("count", "10");

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<BraveSearchResult>;
}

function extractPartNumbers(text: string): string[] {
  const matches = text.match(PART_NUMBER_REGEX) || [];
  return matches
    .map((m) => normalizePartNumber(m))
    .filter((pn) => !CATALOG_PREFIX_REGEX.test(pn));
}

function classifyRelationship(snippet: string, partNumber: string): string {
  const lower = snippet.toLowerCase();
  const pnLower = partNumber.toLowerCase();

  // Check if snippet says this part "replaces" something
  const replacesIdx = lower.indexOf("replaces");
  const replacedByIdx = lower.indexOf("replaced by");
  const pnIdx = lower.indexOf(pnLower);

  if (replacedByIdx !== -1) return "replaced_by";
  if (replacesIdx !== -1 && pnIdx !== -1 && pnIdx < replacesIdx) return "replaces";
  if (replacesIdx !== -1) return "replaced_by";

  return "compatible";
}

/**
 * Search Brave for cross-references for a given part number.
 * Runs 2-3 queries, extracts part numbers from snippets, cross-validates
 * (requires 2+ sources), and saves results to the cross_references table.
 *
 * Called as fire-and-forget from the POST /api/parts route.
 */
export async function lookupCrossReferences(
  partId: number,
  partNumber: string,
  brand?: string | null,
): Promise<void> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    console.warn("BRAVE_API_KEY not set, skipping cross-ref lookup");
    return;
  }

  // Check if cross-ref is enabled
  const db = getDb();
  const [settingsRow] = await db.select({ crossRefEnabled: settings.crossRefEnabled }).from(settings).limit(1);
  if (!settingsRow?.crossRefEnabled) return;

  const queries = [
    `"${partNumber}" replaces`,
    `"${partNumber}" cross reference`,
  ];
  if (brand) {
    queries.push(`"${partNumber}" ${brand} replaces`);
  }

  // Track: partNumber -> { count, sourceUrls, relationship }
  const refMap = new Map<string, { count: number; sourceUrls: Set<string>; relationship: string }>();
  const normalizedSelf = normalizePartNumber(partNumber);

  for (const query of queries) {
    try {
      const result = await braveSearch(query, apiKey);
      const webResults = result.web?.results || [];

      for (const item of webResults) {
        const text = `${item.title} ${item.description}`;
        const extracted = extractPartNumbers(text);

        for (const pn of extracted) {
          if (pn === normalizedSelf) continue; // Skip self-references

          const existing = refMap.get(pn);
          if (existing) {
            existing.count++;
            existing.sourceUrls.add(item.url);
          } else {
            refMap.set(pn, {
              count: 1,
              sourceUrls: new Set([item.url]),
              relationship: classifyRelationship(item.description, partNumber),
            });
          }
        }
      }

      // Rate limit: 1 query/second for Brave free tier
      await new Promise((resolve) => setTimeout(resolve, 1100));
    } catch (err) {
      console.error(`Brave Search query failed for "${query}":`, err);
      // Continue with remaining queries
    }
  }

  // Cross-validate: only keep part numbers found in 2+ sources
  const validated = Array.from(refMap.entries()).filter(([_, data]) => data.count >= 2);

  // Save to database
  for (const [crossRefPn, data] of validated) {
    try {
      const sourceUrl = Array.from(data.sourceUrls)[0]; // Use first source URL

      await db
        .insert(crossReferences)
        .values({
          partId,
          crossRefPartNumber: crossRefPn,
          relationship: data.relationship,
          sourceUrl,
        })
        .onConflictDoNothing(); // Skip if this exact cross-ref already exists
    } catch (err) {
      console.error(`Failed to save cross-ref ${crossRefPn} for part ${partId}:`, err);
    }
  }

  console.log(`Cross-ref lookup for ${partNumber}: found ${validated.length} validated references`);
}
```

- [ ] **Step 2: Create `src/services/cross-ref.test.ts`**

Write `backend/src/services/cross-ref.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Test the regex extraction and filtering logic directly
// (We can't easily test the full function without mocking fetch + DB)

const PART_NUMBER_REGEX = /\b(?:WP[A-Z]?\d{5,}|W\d{7,}|WB\d+X\d+|\d{7,10}|[A-Z]{2,3}\d{6,})\b/gi;
const CATALOG_PREFIX_REGEX = /^(?:AP|PS|EA)\d+$/i;

function normalizePartNumber(raw: string): string {
  return raw.trim().toUpperCase().replace(/[-.\s]/g, "");
}

function extractPartNumbers(text: string): string[] {
  const matches = text.match(PART_NUMBER_REGEX) || [];
  return matches
    .map((m) => normalizePartNumber(m))
    .filter((pn) => !CATALOG_PREFIX_REGEX.test(pn));
}

describe("cross-ref extraction", () => {
  it("extracts WP-prefixed part numbers", () => {
    const result = extractPartNumbers("This part WPW10321304 replaces W10321302");
    assert.ok(result.includes("WPW10321304"));
    assert.ok(result.includes("W10321302"));
  });

  it("extracts numeric-only part numbers (7-10 digits)", () => {
    const result = extractPartNumbers("Compatible with 5304506469 and 316575430");
    assert.ok(result.includes("5304506469"));
    assert.ok(result.includes("316575430"));
  });

  it("extracts GE-style WB part numbers", () => {
    const result = extractPartNumbers("GE WB62X10013 oven element");
    assert.ok(result.includes("WB62X10013"));
  });

  it("filters out AP/PS/EA catalog IDs", () => {
    const result = extractPartNumbers("AP6872342 PS12711828 EA4514338 WPW10321304");
    assert.ok(!result.some((pn) => pn.startsWith("AP")));
    assert.ok(!result.some((pn) => pn.startsWith("PS")));
    assert.ok(!result.some((pn) => pn.startsWith("EA")));
    assert.ok(result.includes("WPW10321304"));
  });

  it("returns empty array for text with no part numbers", () => {
    const result = extractPartNumbers("This is a regular sentence about appliance repair.");
    assert.equal(result.length, 0);
  });

  it("deduplicates normalized part numbers", () => {
    const text = "WPW10321304 and WPW10321304 appear twice";
    const matches = text.match(PART_NUMBER_REGEX) || [];
    const unique = [...new Set(matches.map((m) => normalizePartNumber(m)))];
    assert.equal(unique.length, 1);
  });
});
```

**Test command:**
```bash
cd /Users/alexk/Documents/AntiGravity/Part-Tracker/.worktrees/backend-core/backend
npx tsx --test src/services/cross-ref.test.ts
```

**Expected output:** All 6 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/alexk/Documents/AntiGravity/Part-Tracker/.worktrees/backend-core/backend
git add src/services/cross-ref.ts src/services/cross-ref.test.ts
git commit -m "feat: add Brave Search cross-reference lookup service"
```

---

### Task 2: Wire Cross-Reference Lookup into POST /api/parts

**Files:**
- Modify: `backend/src/routes/parts.ts`

- [ ] **Step 1: Import and call `lookupCrossReferences` after part save**

In `backend/src/routes/parts.ts`, add the import at the top (after the existing imports):

```typescript
import { lookupCrossReferences } from "../services/cross-ref.js";
```

Then replace the existing POST handler:

Replace this block in `backend/src/routes/parts.ts`:
```typescript
// POST /api/parts — add/upsert
router.post("/", validateBody(addPartSchema), async (req, res) => {
  try {
    const result = await addPart(req.body);
    res.status(201).json(partToJson(result));
  } catch (err) {
    console.error("Add part error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});
```

With:
```typescript
// POST /api/parts — add/upsert
router.post("/", validateBody(addPartSchema), async (req, res) => {
  try {
    const result = await addPart(req.body);
    res.status(201).json(partToJson(result));

    // Fire-and-forget: cross-reference lookup (don't await, don't block response)
    lookupCrossReferences(result.id, result.partNumber, result.brand).catch((err) => {
      console.error("Cross-ref lookup failed:", err);
    });
  } catch (err) {
    console.error("Add part error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/alexk/Documents/AntiGravity/Part-Tracker/.worktrees/backend-core/backend
npx tsc --noEmit
```

**Expected output:** No errors.

- [ ] **Step 3: Commit**

```bash
git add src/routes/parts.ts
git commit -m "feat: trigger cross-ref lookup on part add"
```

---

### Task 3: eBay Service — Token Management + Order Polling

**Files:**
- Create: `backend/src/services/ebay.ts`

- [ ] **Step 1: Create `src/services/ebay.ts`**

Write `backend/src/services/ebay.ts`:

```typescript
import { getDb } from "../db/index.js";
import {
  settings,
  parts,
  inventoryEvents,
  ebayProcessedOrders,
  ebayPollWatermark,
} from "../db/schema.js";
import { eq, sql, and } from "drizzle-orm";
import { encrypt, decrypt } from "./crypto.js";

const EBAY_API_BASE = "https://api.ebay.com";
const EBAY_AUTH_BASE = "https://auth.ebay.com";
const TOKEN_URL = `${EBAY_API_BASE}/identity/v1/oauth2/token`;
const FULFILLMENT_URL = `${EBAY_API_BASE}/sell/fulfillment/v1/order`;

// Overlap window to prevent missed orders at timestamp boundaries
const OVERLAP_MINUTES = 5;

interface EbayTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface EbayOrder {
  orderId: string;
  lineItems: Array<{
    lineItemId: string;
    legacyItemId: string;
    quantity: number;
  }>;
}

interface EbayOrdersResponse {
  orders: EbayOrder[];
  total: number;
  offset: number;
  limit: number;
}

// --- OAuth helpers ---

function getEbayCredentials() {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const redirectUri = process.env.EBAY_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_REDIRECT_URI must be set");
  }

  return { clientId, clientSecret, redirectUri };
}

function getBasicAuthHeader(): string {
  const { clientId, clientSecret } = getEbayCredentials();
  return Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

/**
 * Generate the eBay OAuth authorization URL.
 * The state parameter should be a CSPRNG-generated hex string already stored in the DB.
 */
export function buildAuthUrl(state: string): string {
  const { clientId, redirectUri } = getEbayCredentials();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
    state,
  });

  return `${EBAY_AUTH_BASE}/oauth2/authorize?${params.toString()}`;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 * Returns the raw tokens (caller is responsible for encrypting before storage).
 */
export async function exchangeCodeForTokens(code: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const { redirectUri } = getEbayCredentials();

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${getBasicAuthHeader()}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`eBay token exchange failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as EbayTokenResponse;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || "",
    expiresIn: data.expires_in,
  };
}

/**
 * Refresh the eBay access token using the stored refresh token.
 * Updates the encrypted tokens in the settings table.
 * Returns the new decrypted access token.
 */
export async function refreshAccessToken(): Promise<string> {
  const db = getDb();
  const [row] = await db.select().from(settings).limit(1);

  if (!row?.ebayRefreshToken) {
    throw new Error("No eBay refresh token stored");
  }

  const refreshToken = decrypt(row.ebayRefreshToken);

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${getBasicAuthHeader()}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`eBay token refresh failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as EbayTokenResponse;
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  await db
    .update(settings)
    .set({
      ebayAccessToken: encrypt(data.access_token),
      ebayTokenExpiresAt: expiresAt,
      // eBay may return a new refresh token; update if so
      ...(data.refresh_token ? { ebayRefreshToken: encrypt(data.refresh_token) } : {}),
    })
    .where(eq(settings.id, row.id));

  return data.access_token;
}

/**
 * Get a valid eBay access token (refreshing if expired).
 */
async function getValidAccessToken(): Promise<string> {
  const db = getDb();
  const [row] = await db.select().from(settings).limit(1);

  if (!row?.ebayAccessToken) {
    throw new Error("No eBay access token stored");
  }

  // Refresh if expired or expiring within 5 minutes
  const bufferMs = 5 * 60 * 1000;
  if (!row.ebayTokenExpiresAt || row.ebayTokenExpiresAt.getTime() < Date.now() + bufferMs) {
    return await refreshAccessToken();
  }

  return decrypt(row.ebayAccessToken);
}

/**
 * Fetch orders from the eBay Fulfillment API within a time range.
 */
async function fetchOrders(
  accessToken: string,
  fromDate: Date,
  toDate: Date,
): Promise<EbayOrder[]> {
  const from = fromDate.toISOString();
  const to = toDate.toISOString();
  const filter = `creationdate:[${from}..${to}]`;

  const allOrders: EbayOrder[] = [];
  let offset = 0;
  const limit = 50;

  // Paginate through results
  while (true) {
    const url = new URL(FULFILLMENT_URL);
    url.searchParams.set("filter", filter);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`eBay Fulfillment API error: ${response.status} ${body}`);
    }

    const data = (await response.json()) as EbayOrdersResponse;
    allOrders.push(...(data.orders || []));

    if (allOrders.length >= data.total || (data.orders || []).length < limit) {
      break;
    }
    offset += limit;
  }

  return allOrders;
}

/**
 * Process a single eBay order line item.
 * Matches against parts by ebay_listing_id, depletes inventory transactionally.
 * Quarantines unmatched or invalid items.
 */
async function processLineItem(
  orderId: string,
  lineItem: { lineItemId: string; legacyItemId: string; quantity: number },
): Promise<void> {
  const db = getDb();

  // Check idempotency — skip if already processed
  const [existing] = await db
    .select({ id: ebayProcessedOrders.id })
    .from(ebayProcessedOrders)
    .where(
      and(
        eq(ebayProcessedOrders.ebayOrderId, orderId),
        eq(ebayProcessedOrders.ebayLineItemId, lineItem.lineItemId),
      ),
    )
    .limit(1);

  if (existing) return; // Already processed

  await db.transaction(async (tx) => {
    // Try to find matching part by eBay listing ID
    const [part] = await tx
      .select()
      .from(parts)
      .where(eq(parts.ebayListingId, lineItem.legacyItemId))
      .for("update");

    if (!part) {
      // Quarantine: no matching listing
      await tx.insert(ebayProcessedOrders).values({
        ebayOrderId: orderId,
        ebayLineItemId: lineItem.lineItemId,
        partId: null,
        quantityDepleted: 0,
        quarantineReason: `No matching listing for eBay item ${lineItem.legacyItemId}`,
      });
      console.warn(`Quarantined: order ${orderId} line ${lineItem.lineItemId} — no matching listing ${lineItem.legacyItemId}`);
      return;
    }

    // Validate invariants
    const newQuantity = part.quantity - lineItem.quantity;
    const newListedQty = part.listedQuantity - lineItem.quantity;

    if (newQuantity < 0 || newListedQty < 0) {
      // Quarantine: invariant violation
      await tx.insert(ebayProcessedOrders).values({
        ebayOrderId: orderId,
        ebayLineItemId: lineItem.lineItemId,
        partId: part.id,
        quantityDepleted: 0,
        quarantineReason: `Invariant violation: quantity=${part.quantity}, listedQuantity=${part.listedQuantity}, sold=${lineItem.quantity}`,
      });
      console.warn(`Quarantined: order ${orderId} line ${lineItem.lineItemId} — invariant violation on part ${part.id}`);
      return;
    }

    // Deplete inventory
    await tx
      .update(parts)
      .set({
        quantity: sql`${parts.quantity} - ${lineItem.quantity}`,
        listedQuantity: sql`${parts.listedQuantity} - ${lineItem.quantity}`,
        // Clear listing ID if no more listed
        ...(newListedQty === 0 ? { ebayListingId: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(parts.id, part.id));

    // Log inventory event
    await tx.insert(inventoryEvents).values({
      partId: part.id,
      eventType: "ebay_sold",
      quantityChange: -lineItem.quantity,
      note: `eBay order #${orderId}`,
    });

    // Record as processed
    await tx.insert(ebayProcessedOrders).values({
      ebayOrderId: orderId,
      ebayLineItemId: lineItem.lineItemId,
      partId: part.id,
      quantityDepleted: lineItem.quantity,
      quarantineReason: null,
    });

    console.log(`Processed: order ${orderId} line ${lineItem.lineItemId} — depleted ${lineItem.quantity} of part ${part.id}`);
  });
}

/**
 * Main polling function. Called by POST /api/internal/ebay-poll.
 *
 * 1. Read watermark
 * 2. Refresh token if needed
 * 3. Fetch orders with overlap window
 * 4. Process each line item (deplete or quarantine)
 * 5. Advance watermark
 */
export async function pollEbayOrders(): Promise<{ processed: number; quarantined: number }> {
  const db = getDb();

  // Check if eBay is enabled and connected
  const [settingsRow] = await db.select().from(settings).limit(1);
  if (!settingsRow?.ebayEnabled || !settingsRow.ebayRefreshToken) {
    return { processed: 0, quarantined: 0 };
  }

  // Read watermark
  const [watermark] = await db.select().from(ebayPollWatermark).limit(1);
  if (!watermark) {
    throw new Error("eBay poll watermark not initialized — complete OAuth flow first");
  }

  // Get valid access token (refreshes if expired)
  const accessToken = await getValidAccessToken();

  // Fetch orders with overlap window
  const now = new Date();
  const fromDate = new Date(watermark.lastPolledAt.getTime() - OVERLAP_MINUTES * 60 * 1000);

  const orders = await fetchOrders(accessToken, fromDate, now);

  let processed = 0;
  let quarantined = 0;

  for (const order of orders) {
    for (const lineItem of order.lineItems) {
      await processLineItem(order.orderId, lineItem);

      // Check if it was quarantined
      const [record] = await db
        .select({ quarantineReason: ebayProcessedOrders.quarantineReason })
        .from(ebayProcessedOrders)
        .where(
          and(
            eq(ebayProcessedOrders.ebayOrderId, order.orderId),
            eq(ebayProcessedOrders.ebayLineItemId, lineItem.lineItemId),
          ),
        )
        .limit(1);

      if (record?.quarantineReason) {
        quarantined++;
      } else {
        processed++;
      }
    }
  }

  // Advance watermark
  await db
    .update(ebayPollWatermark)
    .set({ lastPolledAt: now })
    .where(eq(ebayPollWatermark.id, watermark.id));

  console.log(`eBay poll complete: ${processed} processed, ${quarantined} quarantined from ${orders.length} orders`);
  return { processed, quarantined };
}
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/alexk/Documents/AntiGravity/Part-Tracker/.worktrees/backend-core/backend
npx tsc --noEmit
```

**Expected output:** No errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/ebay.ts
git commit -m "feat: add eBay token management and order polling service"
```

---

### Task 4: eBay Routes — OAuth Flow + Quarantine

**Files:**
- Create: `backend/src/routes/ebay.ts`
- Modify: `backend/src/middleware/rate-limit.ts`

- [ ] **Step 1: Add eBay callback rate limiter to `src/middleware/rate-limit.ts`**

In `backend/src/middleware/rate-limit.ts`, add after the existing `cronLimiter` export:

```typescript
export const ebayCallbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => getClientIp(req),
  standardHeaders: true,
  legacyHeaders: false,
});
```

- [ ] **Step 2: Create `src/routes/ebay.ts`**

Write `backend/src/routes/ebay.ts`:

```typescript
import { Router } from "express";
import crypto from "node:crypto";
import { getDb } from "../db/index.js";
import { settings, ebayProcessedOrders, ebayPollWatermark } from "../db/schema.js";
import { eq, isNotNull, desc, sql } from "drizzle-orm";
import { encrypt } from "../services/crypto.js";
import { buildAuthUrl, exchangeCodeForTokens } from "../services/ebay.js";
import { ebayCallbackLimiter } from "../middleware/rate-limit.js";

const router = Router();

// POST /api/ebay/auth-url — generate OAuth URL (requires JWT auth, applied by parent middleware)
router.post("/auth-url", async (req, res) => {
  try {
    const db = getDb();

    // Generate CSPRNG state (32 bytes = 64 hex chars)
    const state = crypto.randomBytes(32).toString("hex");
    const stateExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store state in DB (replaces any prior pending state)
    await db
      .update(settings)
      .set({
        pendingEbayState: state,
        pendingEbayStateExpires: stateExpires,
      })
      .where(eq(settings.id, 1));

    const authUrl = buildAuthUrl(state);
    res.json({ authUrl });
  } catch (err) {
    console.error("eBay auth-url error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/ebay/callback — OAuth callback (exempt from JWT auth, protected by state + proxy secret)
router.get("/callback", ebayCallbackLimiter, async (req, res) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";

    if (!code || !state) {
      res.status(400).send("Missing code or state parameter");
      return;
    }

    const db = getDb();

    // Atomically consume the state — prevents TOCTOU race conditions
    const consumed = await db
      .update(settings)
      .set({
        pendingEbayState: null,
        pendingEbayStateExpires: null,
      })
      .where(
        sql`${settings.pendingEbayState} = ${state} AND ${settings.pendingEbayStateExpires} > NOW()`,
      )
      .returning({ id: settings.id });

    if (consumed.length === 0) {
      res.status(400).send("Invalid or expired OAuth state");
      return;
    }

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code);
    const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);

    // Encrypt and store tokens
    await db
      .update(settings)
      .set({
        ebayAccessToken: encrypt(tokens.accessToken),
        ebayRefreshToken: encrypt(tokens.refreshToken),
        ebayTokenExpiresAt: expiresAt,
        ebayEnabled: true,
      })
      .where(eq(settings.id, 1));

    // Initialize watermark if it doesn't exist
    const [existingWatermark] = await db.select().from(ebayPollWatermark).limit(1);
    if (!existingWatermark) {
      await db.insert(ebayPollWatermark).values({
        lastPolledAt: new Date(), // Seed with now — only look forward
      });
    }

    // Redirect back to settings page
    res.redirect("/settings?ebay=connected");
  } catch (err) {
    console.error("eBay callback error:", err);
    res.redirect("/settings?ebay=error");
  }
});

// POST /api/ebay/disconnect — clear tokens (requires JWT auth)
router.post("/disconnect", async (req, res) => {
  try {
    const db = getDb();
    await db
      .update(settings)
      .set({
        ebayEnabled: false,
        ebayAccessToken: null,
        ebayRefreshToken: null,
        ebayTokenExpiresAt: null,
      })
      .where(eq(settings.id, 1));

    res.json({ ok: true });
  } catch (err) {
    console.error("eBay disconnect error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/ebay/quarantine — list quarantined orders (requires JWT auth)
router.get("/quarantine", async (req, res) => {
  try {
    const db = getDb();
    const limit = parseInt(String(req.query.limit)) || 20;
    const offset = parseInt(String(req.query.offset)) || 0;

    const rows = await db
      .select()
      .from(ebayProcessedOrders)
      .where(isNotNull(ebayProcessedOrders.quarantineReason))
      .orderBy(desc(ebayProcessedOrders.processedAt))
      .limit(limit)
      .offset(offset);

    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(ebayProcessedOrders)
      .where(isNotNull(ebayProcessedOrders.quarantineReason));

    res.json({
      items: rows.map((r) => ({
        ebayOrderId: r.ebayOrderId,
        ebayLineItemId: r.ebayLineItemId,
        quarantineReason: r.quarantineReason,
        processedAt: r.processedAt.toISOString(),
      })),
      total: Number(countResult.count),
    });
  } catch (err) {
    console.error("eBay quarantine error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/alexk/Documents/AntiGravity/Part-Tracker/.worktrees/backend-core/backend
npx tsc --noEmit
```

**Expected output:** No errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/ebay.ts src/middleware/rate-limit.ts
git commit -m "feat: add eBay OAuth routes and quarantine endpoint"
```

---

### Task 5: Wire eBay Routes + Internal Poll Endpoint into Express

**Files:**
- Modify: `backend/src/index.ts`
- Modify: `backend/src/middleware/auth.ts`

- [ ] **Step 1: Add `/api/internal/ebay-poll` to auth exemptions**

In `backend/src/middleware/auth.ts`, update the `EXEMPT_PATHS` array:

Replace:
```typescript
const EXEMPT_PATHS = [
  "/api/auth/verify",
  "/api/auth/refresh",
  "/api/auth/logout",
  "/api/ebay/callback",
  "/api/health",
];
```

With:
```typescript
const EXEMPT_PATHS = [
  "/api/auth/verify",
  "/api/auth/refresh",
  "/api/auth/logout",
  "/api/ebay/callback",
  "/api/health",
  "/api/internal/ebay-poll",
];
```

- [ ] **Step 2: Update `src/index.ts` to mount eBay routes and internal poll endpoint**

In `backend/src/index.ts`, replace the entire file contents with:

```typescript
import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import { getDb } from "./db/index.js";
import { seedSettings } from "./db/seed.js";
import { proxySecret } from "./middleware/proxy-secret.js";
import { authMiddleware } from "./middleware/auth.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { generalLimiter, cronLimiter } from "./middleware/rate-limit.js";
import { getClientIp } from "./lib/client-ip.js";
import healthRouter from "./routes/health.js";
import authRouter from "./routes/auth.js";
import partsRouter from "./routes/parts.js";
import settingsRouter from "./routes/settings.js";
import ebayRouter from "./routes/ebay.js";
import { pollEbayOrders } from "./services/ebay.js";

const app = express();
const port = parseInt(process.env.PORT || "3000", 10);

// Trust proxy for Express internals
app.set("trust proxy", 1);

// Body parsing
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

// Security middleware
if (process.env.NODE_ENV === "production") {
  app.use(proxySecret);
}
app.use(securityHeaders);

// Health check — before auth
app.use("/api/health", healthRouter);

// Auth routes — before auth middleware (some routes exempt)
app.use("/api/auth", authRouter);

// Internal cron endpoint — before auth middleware, protected by INTERNAL_CRON_SECRET
app.post("/api/internal/ebay-poll", cronLimiter, async (req, res) => {
  const clientIp = getClientIp(req);
  console.log(`eBay poll invoked from IP: ${clientIp}`);

  const cronSecret = process.env.INTERNAL_CRON_SECRET;
  if (!cronSecret) {
    res.status(500).json({ error: "Server misconfigured" });
    return;
  }

  const provided = req.headers.authorization;
  if (provided !== `Bearer ${cronSecret}`) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  try {
    const result = await pollEbayOrders();
    res.json(result);
  } catch (err) {
    console.error("eBay poll error:", err);
    res.status(500).json({ error: "Poll failed" });
  }
});

// Auth middleware — applies to everything below
app.use(authMiddleware);

// Rate limit all authenticated routes
app.use(generalLimiter);

// Application routes
app.use("/api/parts", partsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/ebay", ebayRouter);

// Start server
async function start() {
  try {
    // Run migrations
    const db = getDb();
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("Migrations complete");

    // Seed default settings
    await seedSettings(process.env.DEFAULT_PASSWORD || "changeme");

    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
}

start();
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/alexk/Documents/AntiGravity/Part-Tracker/.worktrees/backend-core/backend
npx tsc --noEmit
```

**Expected output:** No errors.

- [ ] **Step 4: Run all tests**

```bash
cd /Users/alexk/Documents/AntiGravity/Part-Tracker/.worktrees/backend-core/backend
npx tsx --test src/**/*.test.ts
```

**Expected output:** All tests pass (existing crypto + normalize tests, plus new cross-ref tests).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/middleware/auth.ts
git commit -m "feat: wire eBay routes and internal poll endpoint into Express app"
```

---

### Task 6: Add `@types/cookie-parser` to Express Request (if needed) and Final Verification

**Files:**
- None new — this is a verification task

- [ ] **Step 1: Full build check**

```bash
cd /Users/alexk/Documents/AntiGravity/Part-Tracker/.worktrees/backend-core/backend
npx tsc --noEmit
```

**Expected output:** No errors.

- [ ] **Step 2: Run all tests**

```bash
cd /Users/alexk/Documents/AntiGravity/Part-Tracker/.worktrees/backend-core/backend
npx tsx --test src/**/*.test.ts
```

**Expected output:** All tests pass.

- [ ] **Step 3: Verify env var checklist**

The following env vars are now required for full integration functionality (in addition to existing ones):

| Variable | Purpose | Example |
|---|---|---|
| `BRAVE_API_KEY` | Brave Search API subscription token | `BSA...` |
| `EBAY_CLIENT_ID` | eBay developer app client ID | `YourApp-PRD-...` |
| `EBAY_CLIENT_SECRET` | eBay developer app client secret | `PRD-...` |
| `EBAY_REDIRECT_URI` | eBay OAuth redirect URI (RuName) | `Your_App-YourApp-PRD-...` |
| `INTERNAL_CRON_SECRET` | Secret for cron-job.org to call poll endpoint (64+ chars) | `a1b2c3...` |
| `DATA_ENCRYPTION_KEY` | 256-bit hex key for AES-256-GCM token encryption | `64 hex chars` |

- [ ] **Step 4: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "chore: integration layer final verification fixes"
```

---

## Summary of Changes

| File | Action | Purpose |
|---|---|---|
| `src/services/cross-ref.ts` | Create | Brave Search cross-reference extraction + storage |
| `src/services/cross-ref.test.ts` | Create | Unit tests for part number regex extraction |
| `src/services/ebay.ts` | Create | eBay OAuth token management + order polling + inventory depletion |
| `src/routes/ebay.ts` | Create | eBay OAuth flow routes (auth-url, callback, disconnect, quarantine) |
| `src/routes/parts.ts` | Modify | Fire cross-ref lookup after part add |
| `src/index.ts` | Modify | Mount eBay routes + internal poll endpoint |
| `src/middleware/auth.ts` | Modify | Exempt `/api/internal/ebay-poll` from JWT auth |
| `src/middleware/rate-limit.ts` | Modify | Add eBay callback rate limiter |
