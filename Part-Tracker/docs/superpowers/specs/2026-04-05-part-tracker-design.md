# Part-Tracker Design Spec

## Overview

Internal web app for an appliance repair business to track salvaged parts inventory, look up cross-compatible part numbers, and auto-sync with eBay sales.

**Core use cases:**
- Enter salvaged part numbers into inventory
- Look up a part number via API → get exact match + compatible alternatives from inventory
- Auto-fetch cross-reference data from web search when parts are added (toggleable)
- Auto-deplete inventory when parts sell on eBay

## Tech Stack

- **Frontend:** React + Vite + Tailwind on Cloudflare Pages
- **Backend:** Express + TypeScript on Railway
- **Database:** Neon Postgres + Drizzle ORM
- **Web search:** Brave Search API (free tier, 2000 queries/month)
- **eBay integration:** eBay Fulfillment API (poll for sold orders)

## Database Schema

### `parts`

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `part_number` | text, unique, NOT NULL | Primary lookup key (normalized: uppercase, stripped of spaces/dashes/dots) |
| `brand` | text, nullable | Whirlpool, GE, Samsung, etc. |
| `description` | text, nullable | "Door Shelf Bin", "Upper Spray Arm" |
| `part_number_raw` | text, NOT NULL | Original user input before normalization |
| `quantity` | integer, NOT NULL, default 0 | Total units in stock (available + listed) |
| `listed_quantity` | integer, NOT NULL, default 0 | How many of `quantity` are currently listed on eBay |
| `ebay_listing_id` | text, unique, nullable | eBay listing ID (if any units are listed) |

**Business rule: one active eBay listing per part number.** Multiple listings, relists, or condition-specific listings for the same part are not supported in v1. If this constraint needs to change, migrate to a separate `listings` table.

**Listing invariants (enforced in application logic and/or DB check constraints):**
- `0 <= listed_quantity <= quantity`
- `ebay_listing_id IS NOT NULL` when `listed_quantity > 0`
- `ebay_listing_id IS NULL` when `listed_quantity = 0`
- `PATCH` requests that would violate these invariants are rejected with 400.
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

### `cross_references`

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `part_id` | FK → parts.id, NOT NULL | The part we searched for |
| `cross_ref_part_number` | text, NOT NULL | The related part number found via web search |
| `relationship` | text, NOT NULL | 'replaces', 'replaced_by', 'compatible' |
| `source_url` | text, nullable | Where the data came from (Amazon, PartSelect, etc.) |
| `created_at` | timestamp | |

Unique constraint on `(part_id, cross_ref_part_number)` to prevent duplicate cross-refs.

**Cross-reference dedup:** When querying alternatives for a part, the system searches both directions (edges where this part is `part_id` AND edges where this part's number appears as `cross_ref_part_number`). Results are deduplicated by normalized part number before returning — if both A→B and B→A exist, the alternative appears only once.

### `settings` (single row)

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `cross_ref_enabled` | boolean, default false | Auto web search on part add |
| `ebay_enabled` | boolean, default false | eBay polling active |
| `ebay_access_token` | text, nullable | Encrypted at rest (AES-256-GCM). OAuth 2.0 access token (sell.fulfillment scope) |
| `ebay_refresh_token` | text, nullable | Encrypted at rest (AES-256-GCM). OAuth 2.0 refresh token for token renewal |

**Encryption format:** eBay tokens stored as `base64(nonce):base64(ciphertext):base64(auth_tag)`. Each encryption uses a unique random 12-byte nonce. Key is `DATA_ENCRYPTION_KEY` env var (256-bit). Decrypted only at runtime for eBay API calls.
| `ebay_token_expires_at` | timestamp, nullable | When the access token expires |
| `dark_mode` | boolean, default false | UI theme preference |
| `password_hash` | text, NOT NULL | bcrypt hash for data entry auth |
| `password_version` | integer, NOT NULL, default 1 | Incremented on password change. Embedded in JWT payload; middleware rejects tokens with a stale version. Eliminates clock-skew issues. |
| `pending_ebay_state` | text, nullable | OAuth state parameter for in-flight eBay auth. Set by `/api/ebay/auth-url`, consumed by `/api/ebay/callback`. |
| `pending_ebay_state_expires` | timestamp, nullable | 10-minute TTL for the OAuth state. |

### `inventory_events` (activity timeline)

Every inventory change is logged as an event. The part detail view renders these as a vertical timeline.

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `part_id` | FK → parts.id, NOT NULL | |
| `event_type` | text, NOT NULL | 'added', 'used', 'sold', 'ebay_sold', 'adjusted' |
| `quantity_change` | integer, NOT NULL | Positive for adds, negative for depletions |
| `note` | text, nullable | Free text — e.g., "Pulled from Kenmore Elite #KE-2847", "Repair job #412" |
| `created_at` | timestamp | |

**How it works:**
- `POST /api/parts` (add) → inserts an event with `event_type: 'added'`, `quantity_change: +N`, `note: source info`
- `POST /api/parts/:id/deplete` (used/sold) → inserts event with negative quantity_change and reason
- eBay auto-depletion → inserts event with `event_type: 'ebay_sold'`, `note: "eBay order #XYZ"`
- `parts.quantity` is the running total. Events are the audit trail.

**Timeline UI:** Rendered as a vertical line with nodes, newest at top. Each node shows: event icon, description, quantity change (+3 / -1), timestamp. Scrolls infinitely. Similar to Linear's activity feed or a Git log.

### `ebay_processed_orders` (idempotency table)

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `ebay_order_id` | text, NOT NULL | eBay order ID |
| `ebay_line_item_id` | text, NOT NULL | Specific line item within the order |
| `part_id` | FK → parts.id, nullable | Which part was depleted. NULL if quarantined. |
| `quantity_depleted` | integer, NOT NULL | How many were sold (0 if quarantined) |
| `quarantine_reason` | text, nullable | NULL if successfully processed. Describes failure if quarantined (e.g., "no matching listing", "invariant violation"). |
| `processed_at` | timestamp | When we processed this order |

Unique constraint on `(ebay_order_id, ebay_line_item_id)` — one order can have multiple line items, each processed independently.

### `ebay_poll_watermark` (single row)

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `last_polled_at` | timestamp, NOT NULL | High-water mark for eBay order polling |

**Initialization:** The watermark row is created when eBay is first connected (via `/api/ebay/callback`), seeded with `NOW()` so the first poll only looks forward — no backfill of historical orders.

**Overlap window:** Each poll fetches orders from `last_polled_at - 5 minutes` (overlap) to now. The `ebay_processed_orders` table prevents double-processing of orders seen in the overlap window. The watermark is only advanced after all orders in the batch are successfully processed. This prevents permanently missing orders that share a timestamp and handles partial failures gracefully.

### `sessions` (refresh tokens)

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `refresh_token_hash` | text, unique, NOT NULL | SHA-256 hash of the refresh token. The raw token is only sent to the client in the cookie; the DB never stores it in plaintext. On refresh/logout, the server hashes the cookie value and looks up the hash. |
| `expires_at` | timestamp, NOT NULL | 30 days from creation |
| `created_at` | timestamp | |

Single user, so this table will only ever have a handful of rows. Old sessions can be cleaned up periodically or on login.

### Key design decisions

- Cross-references stored flat, not as chains. `part_id` → `cross_ref_part_number` is queryable both directions (search by `part_id` OR by `cross_ref_part_number` matching a part in the `parts` table).
- No soft deletes. Parts get depleted (quantity → 0), not deleted.
- Bidirectional lookup: searching for a newer part finds older compatible stock, and vice versa.
- Adding a part with an existing `part_number` upserts: increments `quantity`, optionally updates brand/description. Source info lives only in `inventory_events.note`, never on the part itself. `listed_quantity` is not changed on upsert — new stock is implicitly available (`quantity - listed_quantity` = available units).
- **Availability is computed:** `available = quantity - listed_quantity`. No separate status field. A part with `quantity: 5, listed_quantity: 2` has 3 available and 2 on eBay.
- **All inventory mutations are transactional.** Any operation that changes `parts.quantity`, `parts.listed_quantity`, or `parts.ebay_listing_id` must use `SELECT ... FOR UPDATE` on the part row to serialize concurrent mutations. Operations that change `quantity` must also insert the corresponding `inventory_events` row in the same transaction. This prevents `quantity`/`listed_quantity` divergence and invariant violations under concurrent requests (e.g., a manual deplete, a PATCH to `listed_quantity`, and an eBay poll all hitting the same part). Listing invariants are re-checked within the transaction after acquiring the lock.

## Part Number Normalization

All part numbers are normalized before storage and lookup to prevent duplicates and fragmented inventory.

**Normalization rules (applied in order):**
1. Trim whitespace
2. Uppercase
3. Strip dashes, dots, spaces (e.g., `WP-W10321304` → `WPW10321304`, `W 103 213 04` → `W10321304`)
4. Store the original raw input in `part_number_raw` for display

**Applied at:**
- `POST /api/parts` — normalize before insert/upsert
- `GET /api/parts/lookup` — normalize the query param before searching
- Cross-reference extraction — normalize extracted part numbers before storing

**Unique constraint** is on the normalized `part_number`, not the raw input.

## Input Validation

All API inputs are validated with max length limits. Requests exceeding limits return 400. Express body parser configured with `express.json({ limit: '100kb' })`.

| Field | Max length | Notes |
|---|---|---|
| `partNumber` | 50 chars | |
| `brand` | 100 chars | |
| `description` | 500 chars | |
| `note` | 1000 chars | inventory_events.note |
| `password` | 72 chars | bcrypt's actual input limit — reject above this to prevent bcrypt DoS |
| `newPassword` | 72 chars | same as password |

**Numeric and domain constraints (reject with 400 if violated):**

| Field | Constraint |
|---|---|
| `quantity` (on add) | Positive integer, >= 1 |
| `quantity` (on deplete) | Positive integer, >= 1, <= available units |
| `listed_quantity` (on PATCH) | Non-negative integer, must satisfy `0 <= listed_quantity <= quantity` |
| `reason` (on deplete) | Enum: `'used'` or `'sold'` only |
| `status` (on PATCH) | Not accepted — status is derived from quantity/listed_quantity |

## API Endpoints

All endpoints require authentication except `POST /api/auth/verify`, `POST /api/auth/refresh`, `POST /api/auth/logout`, `GET /api/ebay/callback`, and `GET /api/health`. Logout is exempt because it only needs the httpOnly cookie (not an access token) — a user with an expired access token must still be able to log out. Auth middleware applied globally, with these routes exempted (registered before the middleware per backend knowledge doc).

**Route ordering note:** Static routes (`/api/parts/lookup`) must be registered before parameterized routes (`/api/parts/:id`) to prevent Express from matching "lookup" as an `:id`. Alternatively, constrain `:id` to numeric values with a regex param.

### Authenticated

#### `GET /api/parts`
List all parts. Supports `?search=` query param for filtering by part number.

#### `GET /api/parts/lookup?partNumber=XXX`
The main API endpoint. Returns:
```json
{
  "exact": {
    "id": 1,
    "partNumber": "WPW10321304",
    "brand": "Whirlpool",
    "description": "Door Shelf Bin",
    "quantity": 3,
    "listedQuantity": 1,
    "available": 2
  },
  "alternatives": [
    {
      "partNumber": "W10321302",
      "relationship": "older version",
      "quantity": 1,
      "available": 1
    }
  ]
}
```

- `exact` is null if the searched part isn't in inventory
- `alternatives` checks cross_references table both directions: parts that this part replaces AND parts that replace this part, filtered to only those actually in inventory (quantity > 0). Results are deduplicated by normalized part number (see cross-reference dedup below).
- Consumer decides whether to use `alternatives` or ignore it

#### `GET /api/parts/:id`
Get single part with its cross-references and activity timeline. Returns:
```json
{
  "part": { "id": 1, "partNumber": "WPW10321304", "brand": "Whirlpool", ... },
  "crossReferences": [
    { "crossRefPartNumber": "W10321302", "relationship": "replaces", "inStock": true, "quantity": 1 }
  ],
  "events": [
    { "id": 5, "eventType": "used", "quantityChange": -1, "note": "Repair job #412", "createdAt": "..." },
    { "id": 3, "eventType": "added", "quantityChange": 3, "note": "Pulled from Kenmore Elite #KE-2847", "createdAt": "..." }
  ]
}
```
Events are ordered newest-first. Supports `?eventsLimit=N&eventsOffset=N` for paginating the timeline (default limit 20).

#### `GET /api/settings`
Returns a client-safe projection of settings. **Never serializes `password_hash`, `ebay_access_token`, `ebay_refresh_token`, or `ebay_token_expires_at`.**
```json
{
  "crossRefEnabled": true,
  "darkMode": false,
  "ebay": {
    "enabled": true,
    "connected": true,
    "quarantinedCount": 2
  }
}
```
- `connected` is derived from whether valid tokens exist (i.e., the user has completed the OAuth flow). `enabled` can be true but `connected` false if tokens were revoked on eBay's side.
- `quarantinedCount` is the number of unmatched eBay orders (where `quarantine_reason IS NOT NULL` in `ebay_processed_orders`). Shown as a warning badge in the settings UI.

#### `GET /api/ebay/quarantine`
Returns quarantined eBay orders for operator review. Each entry includes `ebay_order_id`, `ebay_line_item_id`, `quarantine_reason`, and `processed_at`. Supports pagination.

Auth model: two-token flow.

1. **Login** (`POST /api/auth/verify`) — password submitted, backend verifies bcrypt hash. On success, returns:
   - **Access token:** stateless JWT (HS256, signed with `JWT_SIGNING_KEY`). Payload: `{ iat, exp, pv }` where `pv` is `password_version` from settings. Short-lived: **2 hours**. Middleware verifies `pv` matches current `password_version` in DB (single cheap query, cacheable).
   - **Refresh token:** random UUID, stored in a `sessions` table in Postgres with a 30-day expiry.
2. **Authenticated requests** — send `Authorization: Bearer <access-token>`. Backend verifies JWT signature, then checks `pv` claim against the current `password_version` in DB (one lightweight query per request — acceptable for single-user scale).
3. **Token refresh** (`POST /api/auth/refresh`) — browser automatically sends the httpOnly cookie. Backend reads the refresh token from the cookie, looks it up in `sessions`, verifies it hasn't expired, and returns a new access token. The refresh token itself stays the same until it expires.
4. **Logout** (`POST /api/auth/logout`) — browser sends the httpOnly cookie. Backend deletes the refresh token from `sessions` and clears the cookie in the response. Access token remains valid until its 2h expiry (acceptable trade-off).

**Frontend flow:** stores access token in memory. Refresh token is stored in an `httpOnly`, `Secure`, `SameSite=Strict`, `Max-Age=2592000` (30 days), `Path=/api/auth` cookie set by the backend on login — the frontend never reads or sends it directly. Access token is sent via `Authorization: Bearer <access-token>` header on all authenticated requests. The refresh token cookie is automatically attached by the browser to `/api/auth/refresh` and `/api/auth/logout` requests (same origin). On 401 response, the frontend calls `/api/auth/refresh` (cookie sent automatically) and retries the original request. If refresh fails (expired/revoked), the backend clears the cookie in the response and the frontend shows the password prompt. On page reload, the access token (in memory) is lost but the httpOnly cookie survives — the app silently calls `/api/auth/refresh` to re-acquire an access token without re-prompting for the password.

**Same-origin architecture:** The frontend on Cloudflare Pages proxies all `/api/*` requests to the Railway backend using Cloudflare Pages Functions (`functions/api/[[path]].ts`). This makes the frontend and API share the same origin, so `SameSite=Strict` httpOnly cookies work without cross-origin issues and no CORS configuration is needed.

**Backend origin protection:** The Railway backend is not directly accessible to users. The proxy function attaches a shared secret header (`X-Proxy-Secret`, value from `PROXY_SHARED_SECRET` env var) on every request to Railway. Express middleware rejects any request missing or mismatching this header — **no exceptions, including the eBay callback**. The only route exempt from `X-Proxy-Secret` is `POST /api/internal/ebay-poll`, which is instead protected by `INTERNAL_CRON_SECRET` in the `Authorization` header (called directly by the external cron service, not through the proxy). The eBay OAuth redirect URL points to the Cloudflare Pages origin (e.g., `https://parts.example.com/api/ebay/callback`), which the proxy forwards to Railway with the shared secret like any other `/api/*` request. Cloudflare Access exempts this single URL from its auth gate via a bypass policy so the eBay redirect lands successfully. This ensures all traffic flows through the Cloudflare Pages proxy, making Cloudflare Access the effective perimeter for both frontend and backend.

**Security considerations:**
- This is an internal tool, single-instance on Railway (v1). All traffic over HTTPS (Cloudflare provides this for the frontend, Railway for the backend).
- Refresh token is stored in an httpOnly, Secure, SameSite=Strict cookie — not accessible to JavaScript, mitigating XSS token theft. Works because the proxy makes everything same-origin.
- **Perimeter security (required):** Place behind Cloudflare Access (zero-trust tunnel) with an IP allowlist or email-based auth. This is a single-password app on the public internet — perimeter control is mandatory, not optional.
- **Rate limiting:**
  - **Client IP:** All IP-dependent logic (rate limiting, logging) reads the `CF-Connecting-IP` header consistently — never `req.ip`. This header is set by Cloudflare and is trustworthy since all traffic flows through the proxy (enforced by `PROXY_SHARED_SECRET`). Rate limiter uses a custom `keyGenerator` that reads this header, falling back to `req.ip` if absent (e.g., local development — in production, absence implies the request didn't come through the proxy, which is already blocked by the shared secret check). `app.set('trust proxy', 1)` is set for Express internals (e.g., `req.protocol`) but is not the source of truth for client IP.
  - `POST /api/auth/verify`: 5 attempts per 15-minute sliding window per IP. If an IP accumulates 10 failures within any 1-hour window, lock out for 1 hour regardless of the 15-minute window. Use an in-memory rate limiter (e.g., `express-rate-limit` + `rate-limit-flexible` for the lockout) — acceptable for single instance.
  - `POST /api/auth/refresh`: 30 requests per minute per IP.
  - `POST /api/internal/ebay-poll`: 1 request per minute (prevent accidental rapid invocation). `INTERNAL_CRON_SECRET` should be 64+ characters of high entropy. Log every invocation with source IP.
  - All other authenticated endpoints: 100 requests per minute per IP (safety net).
- **Security headers — two layers:**
  - **Cloudflare Pages (HTML/static assets):** Set via `public/_headers` file in the frontend repo. These protect the document that loads and executes the frontend JS — this is where CSP, clickjacking, and XSS protections matter most.
    ```
    /*
      Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'
      X-Frame-Options: DENY
      X-Content-Type-Options: nosniff
      Referrer-Policy: strict-origin-when-cross-origin
    ```
    Self-host Material Symbols font files instead of loading from Google Fonts CDN. Vite must be configured to emit external CSS files only (no inline `<style>` injection). Validate CSP against actual build output during development.
  - **Express (API responses):** Set via middleware. Same headers for defense-in-depth, plus `Cache-Control: no-store` on authenticated responses to prevent caching of sensitive data.

#### `POST /api/parts`
Add a new part. Body:
```json
{
  "partNumber": "WPW10321304",
  "brand": "Whirlpool",
  "description": "Door Shelf Bin",
  "quantity": 3,
  "note": "Pulled from Kenmore Elite #KE-2847"
}
```
Only `partNumber` is required. `note` is saved to `inventory_events.note` (not on the part). If cross-ref lookup is enabled in settings, triggers a background web search after saving.

#### `PATCH /api/parts/:id`
Update part metadata only (brand, description, ebay_listing_id, listed_quantity). **Cannot modify quantity directly.** All quantity changes must go through `POST /api/parts` (add) or `POST /api/parts/:id/deplete` so an `inventory_events` row is always created in the same transaction.

#### `POST /api/parts/:id/deplete`
Deplete inventory. Body:
```json
{
  "quantity": 1,
  "reason": "used"  // or "sold"
}
```
Decrements `quantity` and creates an `inventory_events` row. **Only consumes available units** (`quantity - listed_quantity`). If the requested depletion exceeds available units, returns 400. Listed units cannot be depleted manually — they are only depleted by the eBay poll job. If quantity reaches 0, part stays in DB (for cross-ref purposes) but shows as out of stock.

#### `PUT /api/settings`
Update settings (cross_ref_enabled, dark_mode, ebay_enabled). Password changes use a dedicated endpoint. Setting `ebay_enabled` to false pauses polling without revoking the eBay grant — tokens are preserved so polling can be resumed by setting it back to true. To fully disconnect (revoke tokens), use `POST /api/ebay/disconnect`.

#### `POST /api/auth/change-password`
Change password. Body: `{ "currentPassword": "...", "newPassword": "..." }`. Verifies `currentPassword` against the stored bcrypt hash before updating. On success: increments `password_version` in settings, **revokes all existing refresh tokens** (deletes all rows from `sessions` and clears the refresh cookie). The JWT verification middleware checks the token's `pv` claim against the current `password_version` — any token with a stale version is rejected immediately. This eliminates the residual 2-hour window where old access tokens would otherwise remain valid.

#### `POST /api/ebay/disconnect`
Disconnect eBay integration. Sets `ebay_enabled` to false and clears `ebay_access_token`, `ebay_refresh_token`, and `ebay_token_expires_at` from settings. Returns 200. Note: eBay does not provide a public token revocation API — the local tokens are cleared so polling stops, and the tokens will expire naturally on eBay's side. The user can also revoke the app grant from their eBay account settings if desired.

#### `POST /api/ebay/auth-url`
Generates and returns the eBay OAuth authorization URL. POST because it has write side effects: creates/replaces the `pending_ebay_state` in the DB (invalidating any prior in-flight OAuth flow). Frontend redirects the user to the returned URL to grant permissions. Frontend should disable the "Connect" button after clicking to prevent duplicate requests.

#### `GET /api/ebay/callback` (exempt from JWT auth, but protected by proxy secret and OAuth state)
OAuth callback endpoint. eBay redirects the user's browser to the Cloudflare Pages origin (e.g., `https://parts.example.com/api/ebay/callback`), which the proxy forwards to Railway with the shared secret. Cloudflare Access exempts this URL via a bypass policy. Rate-limited to 5 requests per minute. Validated via the OAuth `state` parameter: a CSPRNG-generated 32-byte hex string created by `POST /api/ebay/auth-url` (which IS behind JWT auth), stored in the database (`pending_ebay_state` and `pending_ebay_state_expires` columns on the `settings` row) so it survives redeploys. On callback, the `state` is consumed with a single atomic query: `UPDATE settings SET pending_ebay_state = NULL, pending_ebay_state_expires = NULL WHERE pending_ebay_state = $1 AND pending_ebay_state_expires > NOW() RETURNING *`. If zero rows returned, reject (expired, mismatched, or already consumed). This eliminates TOCTOU race conditions. Only one eBay OAuth flow can be in flight at a time; initiating a new flow invalidates any prior pending state. Exchanges the authorization code for access + refresh tokens (encrypted with AES-256-GCM, see below), stores them in settings, and enables eBay polling. Redirects back to the settings page.

#### `POST /api/auth/verify`
Login. Body: `{ "password": "..." }`. Verifies bcrypt hash. On success, returns `{ "accessToken": "<jwt>" }` and sets an `httpOnly`, `Secure`, `SameSite=Strict` cookie containing the refresh token. On failure, returns 401.

#### `POST /api/auth/refresh`
Exchange a valid refresh token for a new access token. No body needed — backend reads the refresh token from the httpOnly cookie. Returns `{ "accessToken": "<jwt>" }`. Returns 401 if cookie is missing, or refresh token is expired/not found.

#### `POST /api/auth/logout`
Revoke a refresh token. No body needed — backend reads from the httpOnly cookie, deletes the session row from the DB, and clears the cookie in the response. Returns 200 regardless (idempotent).

### Internal

#### eBay polling job
- `POST /api/internal/ebay-poll` endpoint triggered by an external cron service (e.g., cron-job.org) every 5 minutes. POST because it mutates state (refreshes tokens, depletes inventory). Protected by a shared secret (`INTERNAL_CRON_SECRET`) in the `Authorization` header.
- **Flow:**
  1. Read `ebay_poll_watermark` for the last poll timestamp
  2. Refresh the eBay access token if expired (using the refresh token)
  3. Call eBay Fulfillment API `GET /sell/fulfillment/v1/order?filter=creationdate:[{watermark - 5min}..{now}]` with `sell.fulfillment` OAuth scope (overlap window prevents missed orders)
  4. For each order line item:
     a. Skip if `(ebay_order_id, ebay_line_item_id)` already exists in `ebay_processed_orders` (idempotent)
     b. Try to match against `ebay_listing_id` in parts table
     c. **If matched:** in a transaction with `SELECT ... FOR UPDATE` on the part row: decrement both `quantity` and `listed_quantity`, insert `inventory_events` row, insert into `ebay_processed_orders`
     d. **If unmatched or invariant violation** (e.g., no matching listing ID, or depletion would violate `listed_quantity <= quantity`): insert into `ebay_processed_orders` with `part_id = NULL` and a `quarantine_reason` field describing the failure. Log a warning. The line item is marked as processed so it never retries — prevents poison orders from blocking the entire sync.
  5. Update `ebay_poll_watermark` to `now` after processing all line items (both successful and quarantined). The watermark always advances — quarantined items are logged, not retried.
- Only active when `ebay_enabled` is true and tokens are present

#### eBay OAuth flow
- Uses **authorization code grant** (not client credentials)
- Required scopes: `https://api.ebay.com/oauth/api_scope/sell.fulfillment`
- Developer app registered at developer.ebay.com with `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` env vars
- User (seller) authorizes via browser redirect → eBay consent screen → callback
- Access tokens expire (typically 2 hours). Refresh token used to renew automatically before each poll.

## Cross-Reference Web Search

### Trigger
Runs once when a part is added (if enabled in settings). Results saved to `cross_references` table permanently.

### Search strategy
For each new part number, run 2-3 query variants via Brave Search API:
1. `"{partNumber} replaces"`
2. `"{partNumber} cross reference"`
3. `"{partNumber} {brand} replaces"` (if brand is provided)

### Extraction
- Parse search result snippets for part numbers using regex patterns for common appliance part formats (e.g., `WPW\d+`, `\d{10}`, `WB\d+X\d+`)
- Filter out alternate catalog IDs (AP/PS/EA numbers are retailer codes, not physical parts)
- Cross-validate: only keep part numbers that appear in 2+ sources
- Classify as 'replaces', 'replaced_by', or 'compatible' based on context in the snippet

### Rate limiting
Brave Search free tier: 1 query/second, 2000/month. With 2-3 queries per part add, supports ~700-1000 part additions per month.

## Frontend Pages

### 1. Parts Catalog (main view, `/`)
- Searchable list of all parts
- Each row: part number, brand, qty (available / listed)
- Rows clickable → opens part detail modal
- "Add Part" button (requires auth)
- Search bar at top

### 2. Part Detail Modal
- Opens over catalog when a part row is tapped
- Shows: part number, brand, description, quantity (total / available / listed)
- **Activity timeline** — vertical line with event nodes, newest first. Shows every add, use, sale with notes and timestamps. Scrolls infinitely.
- Cross-references section below timeline (from DB, loaded with part data)
  - Each cross-ref shows: part number, relationship, in-stock indicator
- Actions via 3-dot menu: Mark Used, Mark Sold, Edit

### 3. Add Part Form (`/add`)
- Part number (required)
- Brand, description (optional, saved on part)
- Note (optional — e.g., "Pulled from Kenmore Elite #KE-2847". Saved to inventory event, not the part)
- Quantity (default 1)
- On submit: saves, triggers cross-ref search if enabled

### 4. Settings (`/settings`)
- Auto cross-reference lookup toggle
- eBay auto-depletion toggle — on first enable, redirects to eBay OAuth consent screen to authorize the app. Once authorized, shows "Connected" status with option to pause (toggle off) or disconnect (revoke tokens). If quarantined orders exist, shows a warning badge with count and list of unmatched eBay orders for operator review.
- Dark mode toggle
- Change password

### 5. Login Screen
- All endpoints require auth — the app opens to a login screen if no valid session exists
- Simple centered password field, "Unlock" button
- On success, loads the catalog (main view)
- Stays unlocked across page reloads — httpOnly refresh token cookie allows silent re-auth. User only re-enters password if the refresh token expires (30 days of inactivity) or is revoked.

### Navigation
Mobile bottom tab bar: Catalog | Add Part | Settings

## Design System
- Linear/Stripe aesthetic per UI knowledge doc
- White backgrounds, `border-gray-200`, `rounded-lg`
- No shadows on static cards
- Status badges: subtle tinted backgrounds (`bg-green-50 text-green-700`)
- Small understated buttons
- Material Symbols icons
- Dark mode as settings toggle
- Mobile-first, responsive

## Deployment

### Backend (Railway)
- Auto-deploys from GitHub push
- Drizzle migrations run at server startup (inside code, before `listen()`)
- Environment variables: `DATABASE_URL`, `BRAVE_API_KEY`, `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_REDIRECT_URI`, `INTERNAL_CRON_SECRET`, `JWT_SIGNING_KEY` (HS256 signing for access tokens), `DATA_ENCRYPTION_KEY` (AES encryption for eBay tokens at rest), `PROXY_SHARED_SECRET` (validates requests come from the CF Pages proxy). These are separate secrets — never reuse across signing and encryption.
- Health check endpoint: `GET /api/health` — returns only `{ "status": "ok" }` (200) or 503. No version info, no component status, no stack traces.

### Frontend (Cloudflare Pages)
- Build: `npm run build` → outputs to `dist/`
- API proxy: `functions/api/[[path]].ts` — a Cloudflare Pages Function that proxies all `/api/*` requests to the Railway backend URL. This makes the frontend and API same-origin.
- Environment variable (Cloudflare Pages settings): `API_BACKEND_URL` (Railway public URL, e.g., `https://part-tracker-api.up.railway.app` — used server-side by the proxy function, never exposed to the browser. Railway private networking is not reachable from Cloudflare.)

### Database (Neon)
- Serverless Postgres, free tier
- Connection via `DATABASE_URL` env var
