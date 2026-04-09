# Performance Upgrade Plan

Updated: 2026-04-08

## Scope

This document explains why some pages still feel slow, what has already been improved, and which caching, batching, and indexing upgrades should be done next.

## Already Improved

These earlier hotspots are no longer the main bottleneck:

- Auth reads now use a 30-second cache in `backend/src/middleware/auth.ts`.
- Part event pagination now uses `GET /api/parts/:id/events` instead of refetching the full part payload.
- Part cross-reference stock lookup is now batched in `backend/src/routes/parts.ts`.

That means the remaining slowness is now mostly:

- serialized app bootstrap requests
- repeated settings fetches
- search/list query shape
- missing database indexes
- lack of client-side request dedupe/cache

## Why Some Pages Still Load Slowly

### 1. Startup Is Serialized Before The App Becomes Interactive

Current path:

1. `frontend/src/hooks/useAuth.tsx:28` blocks first authenticated render on `POST /api/auth/refresh`
2. `frontend/src/App.tsx:16` then immediately requests `GET /api/settings` to apply dark mode
3. page-specific requests only start after that shell is up

Impact:

- every authenticated visit pays at least one hard round trip
- many visits pay two before the page-specific data fetch even begins
- perceived slowness is worst on fast pages because bootstrap dominates total time

### 2. Settings Is Fetched More Than Once

Current path:

- `frontend/src/App.tsx:16` fetches `/api/settings`
- `frontend/src/pages/Settings.tsx:42` fetches `/api/settings` again on mount
- `backend/src/routes/settings.ts:12` serves that route by reading the settings row and also running a quarantine `count(*)` query at `backend/src/routes/settings.ts:21`

Impact:

- extra network traffic for no user-visible gain
- the same expensive-ish summary route gets hit during bootstrap and again on the Settings page

### 3. Catalog Search Is Still Query-Heavy

Current path:

- `frontend/src/pages/Catalog.tsx:29` fetches `/api/parts`
- `frontend/src/pages/Catalog.tsx:43` adds a 300ms debounce
- `backend/src/routes/parts.ts:54` uses `ILIKE '%...%'`

Impact:

- the 300ms debounce is intentional latency
- `%...%` search usually cannot use a normal B-tree index efficiently
- as the parts table grows, search latency will climb sharply

### 4. Some Detail Pages Still Fetch Large First Payloads

Current path:

- `frontend/src/pages/PartDetail.tsx:67` fetches part metadata, cross refs, and first event page together
- `frontend/src/pages/ApplianceDetail.tsx:69` fetches appliance metadata plus all linked parts
- `backend/src/routes/appliances.ts:106` loads all parts linked to an appliance in one query

Impact:

- this is acceptable for small records
- it will get slower as linked parts and event history grow
- perceived time-to-usable is worse when below-the-fold data ships with above-the-fold data

### 5. List Pages Still Pull More Data Than The UI Usually Needs

Current path:

- `backend/src/routes/parts.ts:48` defaults `/api/parts` to `limit=100`
- `backend/src/routes/appliances.ts:84` defaults `/api/appliances` to `limit=100`
- `frontend/src/pages/Disassemble.tsx:49` re-sorts appliances client-side even though the backend already ordered them

Impact:

- larger payloads on initial list load
- redundant client work
- more rows scanned and serialized than needed for first paint

### 6. The Database Schema Looks Under-Indexed For Current Access Patterns

Current schema highlights:

- `backend/src/db/schema.ts:13` has `parts.applianceId` with no explicit index
- `backend/src/db/schema.ts:15` has `parts.updatedAt` with no explicit index
- `backend/src/db/schema.ts:29` has `appliances.createdAt` with no explicit index
- `backend/src/db/schema.ts:35` has `crossReferences.partId` with no explicit index
- `backend/src/db/schema.ts:63` has `inventoryEvents.partId` with no explicit composite index on `(partId, createdAt)`

Impact:

- list ordering and foreign-key lookups degrade with table growth
- event pagination can become slower than necessary
- linked-part and cross-ref lookups may start scanning more than they should

## Caching Upgrades

### A. Replace Bootstrap Waterfall With A Single Bootstrap Payload

Best option:

- extend `POST /api/auth/refresh` to return:
  - `accessToken`
  - `settingsSummary` with `darkMode`, eBay connection state, and API key summary

Alternative:

- create `GET /api/bootstrap` after refresh that returns shell-level data in one response

Expected win:

- removes one extra bootstrap round trip
- faster first authenticated paint
- simpler client startup logic

### B. Add Client-Side GET Dedupe And Short-Lived Response Cache

Current client:

- `frontend/src/api/client.ts:37` sends every request directly
- it dedupes refresh-token calls only, not normal GETs

Upgrade:

- add in-flight GET dedupe keyed by `method + path + auth state`
- add a tiny TTL cache for safe shell/list endpoints such as:
  - `/api/settings`
  - `/api/parts?search=...&limit=...&offset=...`
  - `/api/appliances?limit=...&offset=...`
- invalidate relevant cache keys after mutations

Expected win:

- avoids duplicate requests during rapid navigation/remounts
- makes back/forward navigation feel much faster
- reduces server load

### C. Keep Settings In Memory Instead Of Refetching It Everywhere

Upgrade:

- create a settings/bootstrap context in the frontend
- hydrate it once at app startup
- let `Settings` read from that context first and revalidate in background if needed

Expected win:

- removes repeated `/api/settings` reads
- keeps dark mode and shell flags consistent without extra calls

### D. Cache Or Precompute The Settings Summary Server-Side

Current route:

- `backend/src/routes/settings.ts:21` recomputes quarantined order count on every `GET /api/settings`

Upgrade options:

1. add a short server-side summary cache for `/api/settings`
2. maintain a persisted `quarantinedCount` summary instead of `count(*)` each request
3. recalculate only on eBay poll/disconnect events

Expected win:

- makes settings/bootstrap cheaper
- reduces repeated aggregation work

### E. Use Private Cache Headers Or ETags For Stable GET Routes

Good candidates:

- `/api/settings`
- paginated list endpoints when the response is user-private but stable for short windows

Expected win:

- cheaper repeat navigations
- more 304 responses instead of full JSON payloads

## Batching Upgrades

### A. Batch Shell Data Into One Response

This is the highest-value batching change.

Bundle these together:

- auth refresh result
- dark mode
- eBay connection state
- API key presence/prefix/scopes
- any top-nav counts that must be shown immediately

### B. Split Above-The-Fold And Below-The-Fold Detail Data

For `PartDetail`:

- load part metadata first
- fetch cross refs and first event page concurrently after modal mount if they are not needed for immediate paint

For `ApplianceDetail`:

- return appliance metadata immediately
- load linked parts on a second request or behind an expandable section when counts are large

Expected win:

- faster time-to-usable on detail views
- less blocking on non-critical data

### C. Batch UI Refreshes After Mutations

Current pattern after some mutations:

- detail view refreshes itself
- parent list refreshes separately

Upgrade:

- update local detail state optimistically
- invalidate one cached list key in the background
- avoid synchronous refetch of both parent and child when not necessary

Expected win:

- faster post-action UI response
- less duplicated network work

## Query And Indexing Upgrades

### Priority Indexes

Add explicit indexes for the access patterns already in use:

- `parts(updated_at desc)`
- `parts(appliance_id)`
- `appliances(created_at desc)`
- `cross_references(part_id)`
- `inventory_events(part_id, created_at desc)`

Likely additional useful indexes:

- partial index for quarantined eBay rows:
  - `ebay_processed_orders(quarantine_reason) where quarantine_reason is not null`
- reverse lookup support if cross-ref lookup expands:
  - `cross_references(cross_ref_part_number)`

### Search Strategy

If substring search must stay:

- add PostgreSQL `pg_trgm`
- add a trigram GIN index on `parts.part_number`

If product requirements allow prefix matching:

- switch from `%term%` to `term%`
- normalize input aggressively and use a normal index-friendly search path

Expected win:

- biggest backend latency reduction for Catalog search

### Pagination Defaults

Reduce initial list sizes:

- lower default list page size from 100 to 25 or 50
- only fetch the next page on scroll or explicit pagination

Expected win:

- smaller JSON payloads
- faster first list paint

## Frontend Request-Control Upgrades

### Abort Stale Search Requests

Current issue:

- `frontend/src/pages/Catalog.tsx:43` debounces but does not cancel stale in-flight searches

Upgrade:

- use `AbortController`
- cancel older requests when a newer search starts
- ignore late responses that do not match the latest search token

Expected win:

- more stable perceived performance under typing
- no stale response overwrite

### Prefetch Likely Next Requests

Useful cases:

- prefetch part detail on row hover/focus in Catalog
- prefetch appliance detail on row hover/focus in Disassemble

Expected win:

- detail views feel near-instant on deliberate navigation

## Rollout Order

### Phase 1: Fastest Wins

- combine auth refresh and bootstrap settings
- stop refetching `/api/settings` in multiple places
- remove redundant client-side appliance sort
- add client GET dedupe

### Phase 2: Query And Index Work

- add the missing indexes
- fix search with trigram or prefix strategy
- lower default list sizes

### Phase 3: Detail-View Optimization

- split critical and non-critical detail payloads
- paginate or lazy-load appliance-linked parts if needed
- background-refresh list views after mutations instead of synchronously refetching both views

### Phase 4: Guardrails

- add endpoint timing logs or traces for:
  - `/api/auth/refresh`
  - `/api/settings`
  - `/api/parts`
  - `/api/parts/:id`
  - `/api/appliances`
  - `/api/appliances/:id`
- track first authenticated paint and list/detail page load timing in the frontend

## Recommended First Build

If only one upgrade pass is funded, do this bundle:

1. return shell settings from auth refresh
2. add frontend bootstrap/settings cache + GET dedupe
3. add indexes on:
   - `parts.updated_at`
   - `parts.appliance_id`
   - `appliances.created_at`
   - `inventory_events(part_id, created_at desc)`
4. replace `%search%` with trigram-backed search

That bundle should materially improve both perceived load time and backend query cost without changing product behavior.
