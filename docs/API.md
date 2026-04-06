# Part-Tracker API Reference

Base URL: `https://your-domain.com`

---

## Authentication

Two methods are supported. JWT gives full access. API keys are scoped.

### JWT Bearer Token

Obtain a token via `POST /api/auth/verify`. Include it in every request:

```
Authorization: Bearer <token>
```

Tokens expire after 2 hours. Use `POST /api/auth/refresh` to get a new one without re-authenticating.

### API Key

Pass the key in a header:

```
X-API-Key: <key>
```

API keys are scoped. A request to an endpoint requiring a scope the key doesn't have returns `403`. Valid scopes:

| Scope              | Grants access to                          |
|--------------------|-------------------------------------------|
| `parts:read`       | GET parts endpoints                       |
| `parts:write`      | POST/PATCH/DELETE parts endpoints         |
| `appliances:read`  | GET appliances endpoints                  |
| `appliances:write` | POST/PATCH/DELETE appliances endpoints    |

API keys do not grant access to auth, settings, or eBay endpoints — those require JWT.

---

## Error Responses

All errors return JSON with an `error` field:

```json
{
  "error": "Human-readable error message"
}
```

Validation errors (from request body validation) include field-level details:

```json
{
  "error": "Validation failed",
  "details": {
    "partNumber": ["Required"],
    "quantity": ["Expected number, received string"]
  }
}
```

### Common Status Codes

| Code  | Meaning                                                                 |
|-------|-------------------------------------------------------------------------|
| `400` | Bad request — missing required fields, validation failure, or invalid operation (e.g. depleting more than available) |
| `401` | Unauthorized — missing/invalid/expired token or API key                |
| `403` | Forbidden — API key lacks the required scope, or proxy secret mismatch |
| `404` | Resource not found                                                      |
| `503` | Service not configured — OCR (ZAI_API_KEY) or R2 storage missing      |
| `500` | Internal server error                                                   |

---

## Auth

### POST /api/auth/verify

Authenticate with password. Returns an access token and sets an `HttpOnly` refresh token cookie.

No auth required.

**Request:**
```json
{
  "password": "string"
}
```

**Response:**
```json
{
  "accessToken": "eyJ..."
}
```

**Errors:**

| Code  | Error                       |
|-------|-----------------------------|
| `401` | `Invalid password`          |
| `500` | `Settings not initialized`  |

---

### POST /api/auth/refresh

Exchange the refresh token cookie for a new access token. No request body needed.

No auth required.

**Response:**
```json
{
  "accessToken": "eyJ..."
}
```

Clears the cookie and returns `401` if the refresh token is missing, invalid, or expired.

---

### POST /api/auth/logout

Invalidates the current refresh token and clears the cookie.

No auth required.

**Response:**
```json
{ "ok": true }
```

---

### POST /api/auth/change-password

Changes the password. Invalidates all existing sessions (including all refresh tokens).

**Auth:** JWT required.

**Request:**
```json
{
  "currentPassword": "string",
  "newPassword": "string"
}
```

**Response:**
```json
{ "ok": true }
```

**Errors:**

| Code  | Error                          |
|-------|--------------------------------|
| `401` | `Current password is incorrect`|

---

## Parts

### GET /api/parts/lookup  *(primary endpoint for external tools)*

Look up a part by part number. Returns the exact match (if any) plus in-stock alternatives found via cross-reference data.

**Auth:** JWT or API key with `parts:read`

**Query params:**

| Param        | Type   | Required | Description                        |
|--------------|--------|----------|------------------------------------|
| `partNumber` | string | yes      | Part number to look up (raw input) |

**Response:**
```json
{
  "found": true,
  "part": {
    "id": 1,
    "partNumber": "WP8577274",
    "partNumberRaw": "WP8577274",
    "brand": "Whirlpool",
    "description": "Control board",
    "quantity": 3,
    "listedQuantity": 1,
    "available": 2,
    "ebayListingId": "123456789012",
    "applianceId": 5,
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T00:00:00.000Z"
  },
  "alternatives": [
    {
      "partNumber": "8577274",
      "relationship": "supersedes",
      "quantity": 2,
      "available": 2
    }
  ]
}
```

When the part number is not found in inventory, `found` is `false` and `part` is `null`. Alternatives may still be present if cross-reference data links to in-stock parts.

**Errors:**

| Code  | Error                          |
|-------|--------------------------------|
| `400` | `partNumber query param required` |

---

### GET /api/parts

List all parts, newest first. Optionally filter by part number substring.

**Auth:** JWT or API key with `parts:read`

**Query params:**

| Param    | Type   | Required | Description                      |
|----------|--------|----------|----------------------------------|
| `search` | string | no       | Substring match on part number   |

**Response:** Array of part objects (same shape as `part` in the lookup response).

---

### GET /api/parts/:id

Get a single part with its cross-references and inventory event history.

**Auth:** JWT or API key with `parts:read`

**Query params:**

| Param          | Type | Required | Default | Description                     |
|----------------|------|----------|---------|---------------------------------|
| `eventsLimit`  | int  | no       | 20      | Max events to return            |
| `eventsOffset` | int  | no       | 0       | Pagination offset for events    |

**Response:**
```json
{
  "part": { ... },
  "crossReferences": [
    {
      "crossRefPartNumber": "8577274",
      "relationship": "supersedes",
      "inStock": true,
      "quantity": 2
    }
  ],
  "events": [
    {
      "id": 1,
      "eventType": "add",
      "quantityChange": 3,
      "note": "Pulled from Whirlpool WTW5000DW (appliance #5)",
      "createdAt": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

**Errors:**

| Code  | Error            |
|-------|------------------|
| `404` | `Part not found` |

---

### POST /api/parts

Add inventory for a part. If the part number already exists, quantity is incremented (upsert behavior). Triggers cross-reference lookup in the background.

**Auth:** JWT or API key with `parts:write`

**Request:**
```json
{
  "partNumber": "string",
  "brand": "string (optional)",
  "description": "string (optional)",
  "quantity": 1,
  "note": "string (optional)"
}
```

**Response:** `201` with the part object.

---

### PATCH /api/parts/:id

Update part metadata. Does not affect quantity.

**Auth:** JWT or API key with `parts:write`

**Request:** All fields optional.
```json
{
  "brand": "string",
  "description": "string",
  "ebayListingId": "string | null",
  "listedQuantity": 0
}
```

**Response:** Updated part object.

**Errors:**

| Code  | Error                                                             |
|-------|-------------------------------------------------------------------|
| `404` | `Part not found`                                                  |
| `400` | `listed_quantity must be between 0 and {quantity}`                |
| `400` | `ebay_listing_id required when listed_quantity > 0`              |
| `400` | `ebay_listing_id must be null when listed_quantity is 0`         |

---

### POST /api/parts/:id/deplete

Reduce inventory for a part (used in repair or sold outside eBay).

**Auth:** JWT or API key with `parts:write`

**Request:**
```json
{
  "quantity": 1,
  "reason": "used | sold"
}
```

**Response:** Updated part object.

**Errors:**

| Code  | Error                                                                                           |
|-------|-------------------------------------------------------------------------------------------------|
| `404` | `Part not found`                                                                                |
| `400` | `Cannot deplete {n} -- only {available} available ({listed} listed on eBay)` |

---

### DELETE /api/parts/:id

Delete a part and all associated cross-references and inventory events.

**Auth:** JWT or API key with `parts:write`

**Response:**
```json
{ "ok": true }
```

**Errors:**

| Code  | Error            |
|-------|------------------|
| `404` | `Part not found` |

---

## Appliances

### GET /api/appliances

List all appliances, newest first.

**Auth:** JWT or API key with `appliances:read`

**Response:** Array of appliance objects:
```json
[
  {
    "id": 1,
    "brand": "Whirlpool",
    "modelNumber": "WTW5000DW",
    "serialNumber": "C12345678",
    "applianceType": "Washing Machine",
    "notes": "Bought at auction",
    "photoKey": "appliances/1700000000-abc123.jpg",
    "status": "active",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T00:00:00.000Z"
  }
]
```

`status` is either `"active"` or `"stripped"`.

---

### GET /api/appliances/:id

Get a single appliance with its linked parts.

**Auth:** JWT or API key with `appliances:read`

**Response:**
```json
{
  "appliance": { ... },
  "parts": [ ... ]
}
```

**Errors:**

| Code  | Error                 |
|-------|-----------------------|
| `404` | `Appliance not found` |

---

### POST /api/appliances

Create an appliance.

**Auth:** JWT or API key with `appliances:write`

**Request:** All fields optional.
```json
{
  "brand": "string",
  "modelNumber": "string",
  "serialNumber": "string",
  "applianceType": "string",
  "notes": "string",
  "photoKey": "string"
}
```

**Response:** `201` with the appliance object.

---

### PATCH /api/appliances/:id

Update appliance fields. All fields optional.

**Auth:** JWT or API key with `appliances:write`

**Request:**
```json
{
  "brand": "string",
  "modelNumber": "string",
  "serialNumber": "string",
  "applianceType": "string",
  "notes": "string",
  "photoKey": "string",
  "status": "active | stripped"
}
```

**Response:** Updated appliance object.

---

### DELETE /api/appliances/:id

Delete an appliance. Parts linked to it are unlinked (not deleted).

**Auth:** JWT or API key with `appliances:write`

**Response:**
```json
{ "ok": true }
```

**Errors:**

| Code  | Error                 |
|-------|-----------------------|
| `404` | `Appliance not found` |

---

### POST /api/appliances/:id/parts

Add a part directly linked to this appliance. Same upsert behavior as `POST /api/parts`. Automatically sets a provenance note if `note` is omitted.

**Auth:** JWT or API key with `appliances:write`

**Request:**
```json
{
  "partNumber": "string",
  "brand": "string (optional)",
  "description": "string (optional)",
  "quantity": 1,
  "note": "string (optional)"
}
```

**Response:** `201` with the part object.

---

### POST /api/appliances/ocr

Extract model number and serial number from a sticker photo using AI vision. Send before creating the appliance to pre-fill fields.

**Auth:** JWT or API key with `appliances:write`

**Request:**
```json
{
  "image": "<base64-encoded image, max 10MB>"
}
```

**Response:** Extracted appliance info (fields vary based on what's visible in the image).

**Errors:**

| Code  | Error                                   |
|-------|-----------------------------------------|
| `400` | `image must be a base64 string`         |
| `400` | `image exceeds 10MB limit`              |
| `503` | `OCR service not configured`            |

---

### POST /api/appliances/upload

Upload a photo to R2 storage. Returns a `key` that can be passed as `photoKey` when creating or updating an appliance.

**Auth:** JWT or API key with `appliances:write`

**Request:**
```json
{
  "image": "<base64-encoded image, max 10MB>",
  "contentType": "image/jpeg (optional, default: image/jpeg)"
}
```

**Response:**
```json
{
  "key": "appliances/1700000000-abc123.jpg"
}
```

**Errors:**

| Code  | Error                                     |
|-------|-------------------------------------------|
| `400` | `image (base64 string) required`          |
| `400` | `Image too large (max 10MB)`              |
| `503` | `R2 storage is not configured`            |

---

## Settings

All settings endpoints require authentication. No scope restrictions are enforced — any valid JWT or API key can reach them.

### GET /api/settings

Returns current settings and integration status.

**Auth:** JWT or API key.

**Response:**
```json
{
  "crossRefEnabled": true,
  "darkMode": false,
  "ebay": {
    "enabled": true,
    "connected": true,
    "quarantinedCount": 2
  },
  "apiKey": {
    "exists": true,
    "prefix": "a1b2c3d4",
    "scopes": ["parts:read", "parts:write"]
  }
}
```

---

### PUT /api/settings

Update one or more settings flags.

**Auth:** JWT required.

**Request:** All fields optional.
```json
{
  "crossRefEnabled": true,
  "darkMode": false,
  "ebayEnabled": true
}
```

**Response:**
```json
{ "ok": true }
```

---

### POST /api/settings/api-key

Generate (or regenerate) an API key with the specified scopes. Replaces any existing key.

**Auth:** JWT required.

**Request:**
```json
{
  "scopes": ["parts:read", "parts:write", "appliances:read", "appliances:write"]
}
```

At least one scope is required. Valid values: `parts:read`, `parts:write`, `appliances:read`, `appliances:write`.

**Errors:**

| Code  | Error                            |
|-------|----------------------------------|
| `400` | `At least one scope is required` |
| `400` | `Invalid scopes: {list}`         |

**Response:**
```json
{
  "key": "a1b2c3d4...",
  "prefix": "a1b2c3d4",
  "scopes": ["parts:read"]
}
```

The full `key` is only returned once. Store it immediately.

---

### DELETE /api/settings/api-key

Revoke the current API key.

**Auth:** JWT required.

**Response:**
```json
{ "ok": true }
```

---

## eBay

All eBay endpoints require authentication. No scope restrictions are enforced — any valid JWT or API key can reach them (except the callback, which is exempt from auth).

### POST /api/ebay/auth-url

Generate an eBay OAuth authorization URL. Redirect the user to this URL to connect their eBay account.

**Auth:** JWT required.

**Response:**
```json
{
  "authUrl": "https://auth.ebay.com/oauth2/authorize?..."
}
```

---

### GET /api/ebay/callback

OAuth redirect target. eBay redirects here after the user authorizes. Stores tokens and redirects the browser to `/settings?ebay=connected`.

No auth required (exempt path). This is called by eBay's servers, not your client.

---

### POST /api/ebay/disconnect

Disconnect the eBay integration. Clears stored tokens.

**Auth:** JWT required.

**Response:**
```json
{ "ok": true }
```

---

### GET /api/ebay/quarantine

List eBay orders that failed to process automatically and were quarantined for manual review.

**Auth:** JWT required.

**Query params:**

| Param    | Type | Required | Default | Description       |
|----------|------|----------|---------|-------------------|
| `limit`  | int  | no       | 20      | Max items         |
| `offset` | int  | no       | 0       | Pagination offset |

**Response:**
```json
{
  "items": [
    {
      "ebayOrderId": "12-34567-89012",
      "ebayLineItemId": "1234567890",
      "quarantineReason": "Part number not found: WP8577274",
      "processedAt": "2025-01-01T00:00:00.000Z"
    }
  ],
  "total": 5
}
```

---

## Health

### GET /api/health

Liveness check. No auth required.

**Response:**
```json
{ "status": "ok" }
```
