# Backend Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Express + TypeScript backend with auth, parts CRUD, inventory events, and all security middleware — everything except eBay and cross-reference integrations.

**Architecture:** Monorepo with `backend/` and `frontend/` directories. Backend is Express + TypeScript on Railway, Drizzle ORM for Postgres on Neon. Auth uses JWT access tokens + httpOnly cookie refresh tokens with SHA-256 hashed storage. All inventory mutations are transactional with row-level locking.

**Tech Stack:** Express, TypeScript, Drizzle ORM, Neon Postgres, bcrypt, jsonwebtoken, zod, express-rate-limit

**Spec:** `docs/superpowers/specs/2026-04-05-part-tracker-design.md`

---

## File Structure

```
backend/
  package.json
  tsconfig.json
  drizzle.config.ts
  src/
    index.ts                    # Express app entry, migration, listen
    db/
      schema.ts                 # All Drizzle table definitions
      index.ts                  # DB connection (lazy eval, not module-load)
      seed.ts                   # Seed initial settings row with hashed password
    middleware/
      proxy-secret.ts           # X-Proxy-Secret validation
      auth.ts                   # JWT verification + password_version check
      rate-limit.ts             # Rate limiting config per endpoint
      security-headers.ts       # CSP, X-Frame-Options, etc.
      validate.ts               # Zod-based request validation factory
    routes/
      health.ts                 # GET /api/health
      auth.ts                   # verify, refresh, logout, change-password
      parts.ts                  # CRUD, lookup, deplete
      settings.ts               # GET/PUT settings
    services/
      normalize.ts              # Part number normalization
      inventory.ts              # Transactional inventory mutations
      crypto.ts                 # AES-256-GCM encrypt/decrypt for eBay tokens (stub for now)
    lib/
      client-ip.ts              # CF-Connecting-IP extraction helper
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `backend/package.json`
- Create: `backend/tsconfig.json`
- Create: `backend/drizzle.config.ts`
- Create: `backend/.env.example`

- [ ] **Step 1: Initialize backend package**

```bash
cd /Users/alexk/Documents/AntiGravity/Part-Tracker
mkdir -p backend
cd backend
npm init -y
```

- [ ] **Step 2: Install dependencies**

```bash
npm install express drizzle-orm @neondatabase/serverless jsonwebtoken bcrypt zod express-rate-limit rate-limiter-flexible dotenv
npm install -D typescript @types/express @types/jsonwebtoken @types/bcrypt drizzle-kit tsx @types/node
```

- [ ] **Step 3: Create tsconfig.json**

Write `backend/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create drizzle.config.ts**

Write `backend/drizzle.config.ts`:
```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

- [ ] **Step 5: Create .env.example**

Write `backend/.env.example`:
```
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
JWT_SIGNING_KEY=your-256-bit-secret-here
DATA_ENCRYPTION_KEY=your-256-bit-hex-key-here
PROXY_SHARED_SECRET=your-proxy-secret-here
INTERNAL_CRON_SECRET=your-64-char-cron-secret-here
BRAVE_API_KEY=your-brave-api-key
EBAY_CLIENT_ID=
EBAY_CLIENT_SECRET=
EBAY_REDIRECT_URI=
PORT=3000
```

- [ ] **Step 6: Add scripts to package.json**

Update `backend/package.json` scripts:
```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -b",
    "start": "node dist/index.js",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/db/migrate.ts",
    "test": "tsx --test src/**/*.test.ts"
  }
}
```

- [ ] **Step 7: Verify TypeScript compiles**

```bash
npx tsc -b --noEmit
```
Expected: no errors (no source files yet, just config validation)

- [ ] **Step 8: Commit**

```bash
git add backend/
git commit -m "feat: scaffold backend project with Express + TypeScript + Drizzle"
```

---

### Task 2: Database Schema

**Files:**
- Create: `backend/src/db/schema.ts`
- Create: `backend/src/db/index.ts`

- [ ] **Step 1: Write schema tests**

Create `backend/src/db/schema.test.ts`:
```typescript
import { describe, it } from "node:test";
import * as assert from "node:assert";
import { parts, crossReferences, settings, inventoryEvents, ebayProcessedOrders, ebayPollWatermark, sessions } from "./schema.js";

describe("schema", () => {
  it("parts table has all required columns", () => {
    const cols = Object.keys(parts);
    assert.ok(cols.includes("id"));
    assert.ok(cols.includes("partNumber"));
    assert.ok(cols.includes("partNumberRaw"));
    assert.ok(cols.includes("brand"));
    assert.ok(cols.includes("description"));
    assert.ok(cols.includes("quantity"));
    assert.ok(cols.includes("listedQuantity"));
    assert.ok(cols.includes("ebayListingId"));
    assert.ok(cols.includes("createdAt"));
    assert.ok(cols.includes("updatedAt"));
  });

  it("settings table has all required columns", () => {
    const cols = Object.keys(settings);
    assert.ok(cols.includes("crossRefEnabled"));
    assert.ok(cols.includes("ebayEnabled"));
    assert.ok(cols.includes("ebayAccessToken"));
    assert.ok(cols.includes("ebayRefreshToken"));
    assert.ok(cols.includes("ebayTokenExpiresAt"));
    assert.ok(cols.includes("darkMode"));
    assert.ok(cols.includes("passwordHash"));
    assert.ok(cols.includes("passwordVersion"));
    assert.ok(cols.includes("pendingEbayState"));
    assert.ok(cols.includes("pendingEbayStateExpires"));
  });

  it("inventory_events table has all required columns", () => {
    const cols = Object.keys(inventoryEvents);
    assert.ok(cols.includes("partId"));
    assert.ok(cols.includes("eventType"));
    assert.ok(cols.includes("quantityChange"));
    assert.ok(cols.includes("note"));
  });

  it("sessions table stores hashed tokens", () => {
    const cols = Object.keys(sessions);
    assert.ok(cols.includes("refreshTokenHash"));
    assert.ok(!cols.includes("refreshToken"), "should not store raw refresh token");
  });

  it("ebay_processed_orders has quarantine support", () => {
    const cols = Object.keys(ebayProcessedOrders);
    assert.ok(cols.includes("quarantineReason"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/alexk/Documents/AntiGravity/Part-Tracker/backend
npx tsx --test src/db/schema.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Write the schema**

Create `backend/src/db/schema.ts`:
```typescript
import { pgTable, serial, text, integer, boolean, timestamp, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const parts = pgTable("parts", {
  id: serial("id").primaryKey(),
  partNumber: text("part_number").notNull().unique(),
  partNumberRaw: text("part_number_raw").notNull(),
  brand: text("brand"),
  description: text("description"),
  quantity: integer("quantity").notNull().default(0),
  listedQuantity: integer("listed_quantity").notNull().default(0),
  ebayListingId: text("ebay_listing_id").unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  check("listed_quantity_check", sql`${table.listedQuantity} >= 0 AND ${table.listedQuantity} <= ${table.quantity}`),
]);

export const crossReferences = pgTable("cross_references", {
  id: serial("id").primaryKey(),
  partId: integer("part_id").notNull().references(() => parts.id),
  crossRefPartNumber: text("cross_ref_part_number").notNull(),
  relationship: text("relationship").notNull(),
  sourceUrl: text("source_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  unique("cross_ref_unique").on(table.partId, table.crossRefPartNumber),
]);

export const settings = pgTable("settings", {
  id: serial("id").primaryKey(),
  crossRefEnabled: boolean("cross_ref_enabled").notNull().default(false),
  ebayEnabled: boolean("ebay_enabled").notNull().default(false),
  ebayAccessToken: text("ebay_access_token"),
  ebayRefreshToken: text("ebay_refresh_token"),
  ebayTokenExpiresAt: timestamp("ebay_token_expires_at"),
  darkMode: boolean("dark_mode").notNull().default(false),
  passwordHash: text("password_hash").notNull(),
  passwordVersion: integer("password_version").notNull().default(1),
  pendingEbayState: text("pending_ebay_state"),
  pendingEbayStateExpires: timestamp("pending_ebay_state_expires"),
});

export const inventoryEvents = pgTable("inventory_events", {
  id: serial("id").primaryKey(),
  partId: integer("part_id").notNull().references(() => parts.id),
  eventType: text("event_type").notNull(),
  quantityChange: integer("quantity_change").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const ebayProcessedOrders = pgTable("ebay_processed_orders", {
  id: serial("id").primaryKey(),
  ebayOrderId: text("ebay_order_id").notNull(),
  ebayLineItemId: text("ebay_line_item_id").notNull(),
  partId: integer("part_id").references(() => parts.id),
  quantityDepleted: integer("quantity_depleted").notNull(),
  quarantineReason: text("quarantine_reason"),
  processedAt: timestamp("processed_at").notNull().defaultNow(),
}, (table) => [
  unique("ebay_order_line_unique").on(table.ebayOrderId, table.ebayLineItemId),
]);

export const ebayPollWatermark = pgTable("ebay_poll_watermark", {
  id: serial("id").primaryKey(),
  lastPolledAt: timestamp("last_polled_at").notNull(),
});

export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  refreshTokenHash: text("refresh_token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

- [ ] **Step 4: Write DB connection module**

Create `backend/src/db/index.ts`:
```typescript
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool } from "@neondatabase/serverless";
import * as schema from "./schema.js";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!_db) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    const pool = new Pool({ connectionString });
    _db = drizzle(pool, { schema });
  }
  return _db;
}
```

- [ ] **Step 5: Run tests**

```bash
npx tsx --test src/db/schema.test.ts
```
Expected: PASS — all assertions pass (tests only check exported column names)

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc -b --noEmit
```
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/db/
git commit -m "feat: add Drizzle schema for all tables"
```

---

### Task 3: Part Number Normalization

**Files:**
- Create: `backend/src/services/normalize.ts`
- Create: `backend/src/services/normalize.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/services/normalize.test.ts`:
```typescript
import { describe, it } from "node:test";
import * as assert from "node:assert";
import { normalizePartNumber } from "./normalize.js";

describe("normalizePartNumber", () => {
  it("uppercases input", () => {
    assert.strictEqual(normalizePartNumber("wpw10321304"), "WPW10321304");
  });

  it("strips dashes", () => {
    assert.strictEqual(normalizePartNumber("WP-W10321304"), "WPW10321304");
  });

  it("strips dots", () => {
    assert.strictEqual(normalizePartNumber("W.10321304"), "W10321304");
  });

  it("strips spaces", () => {
    assert.strictEqual(normalizePartNumber("W 103 213 04"), "W10321304");
  });

  it("trims whitespace", () => {
    assert.strictEqual(normalizePartNumber("  WPW10321304  "), "WPW10321304");
  });

  it("handles combined cases", () => {
    assert.strictEqual(normalizePartNumber("  wp-w.103 213-04  "), "WPW10321304");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsx --test src/services/normalize.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `backend/src/services/normalize.ts`:
```typescript
export function normalizePartNumber(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[-.\s]/g, "");
}
```

- [ ] **Step 4: Run tests**

```bash
npx tsx --test src/services/normalize.test.ts
```
Expected: PASS — all 6 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/services/normalize.ts src/services/normalize.test.ts
git commit -m "feat: add part number normalization"
```

---

### Task 4: Input Validation Schemas

**Files:**
- Create: `backend/src/middleware/validate.ts`
- Create: `backend/src/middleware/validate.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/middleware/validate.test.ts`:
```typescript
import { describe, it } from "node:test";
import * as assert from "node:assert";
import { addPartSchema, depletePartSchema, updateSettingsSchema, changePasswordSchema, updatePartSchema } from "./validate.js";

describe("addPartSchema", () => {
  it("accepts valid input", () => {
    const result = addPartSchema.safeParse({
      partNumber: "WPW10321304",
      quantity: 3,
      note: "From Kenmore",
    });
    assert.ok(result.success);
  });

  it("requires partNumber", () => {
    const result = addPartSchema.safeParse({ quantity: 1 });
    assert.ok(!result.success);
  });

  it("rejects partNumber over 50 chars", () => {
    const result = addPartSchema.safeParse({ partNumber: "A".repeat(51) });
    assert.ok(!result.success);
  });

  it("rejects quantity of 0", () => {
    const result = addPartSchema.safeParse({ partNumber: "X", quantity: 0 });
    assert.ok(!result.success);
  });

  it("defaults quantity to 1", () => {
    const result = addPartSchema.safeParse({ partNumber: "X" });
    assert.ok(result.success);
    assert.strictEqual(result.data.quantity, 1);
  });

  it("rejects note over 1000 chars", () => {
    const result = addPartSchema.safeParse({ partNumber: "X", note: "A".repeat(1001) });
    assert.ok(!result.success);
  });
});

describe("depletePartSchema", () => {
  it("accepts valid input", () => {
    const result = depletePartSchema.safeParse({ quantity: 1, reason: "used" });
    assert.ok(result.success);
  });

  it("rejects invalid reason", () => {
    const result = depletePartSchema.safeParse({ quantity: 1, reason: "lost" });
    assert.ok(!result.success);
  });

  it("rejects quantity of 0", () => {
    const result = depletePartSchema.safeParse({ quantity: 0, reason: "used" });
    assert.ok(!result.success);
  });
});

describe("changePasswordSchema", () => {
  it("rejects password over 72 chars", () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: "old",
      newPassword: "A".repeat(73),
    });
    assert.ok(!result.success);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsx --test src/middleware/validate.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Write validation schemas**

Create `backend/src/middleware/validate.ts`:
```typescript
import { z } from "zod";
import type { Request, Response, NextFunction } from "express";

export const addPartSchema = z.object({
  partNumber: z.string().min(1).max(50),
  brand: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  quantity: z.number().int().min(1).default(1),
  note: z.string().max(1000).optional(),
});

export const depletePartSchema = z.object({
  quantity: z.number().int().min(1),
  reason: z.enum(["used", "sold"]),
});

export const updatePartSchema = z.object({
  brand: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  ebayListingId: z.string().optional().nullable(),
  listedQuantity: z.number().int().min(0).optional(),
});

export const updateSettingsSchema = z.object({
  crossRefEnabled: z.boolean().optional(),
  darkMode: z.boolean().optional(),
  ebayEnabled: z.boolean().optional(),
});

export const loginSchema = z.object({
  password: z.string().min(1).max(72),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(72),
  newPassword: z.string().min(1).max(72),
});

export function validateBody<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: "Validation failed", details: result.error.flatten().fieldErrors });
      return;
    }
    req.body = result.data;
    next();
  };
}
```

- [ ] **Step 4: Run tests**

```bash
npx tsx --test src/middleware/validate.test.ts
```
Expected: PASS — all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/middleware/validate.ts src/middleware/validate.test.ts
git commit -m "feat: add zod input validation schemas"
```

---

### Task 5: Security Middleware

**Files:**
- Create: `backend/src/middleware/proxy-secret.ts`
- Create: `backend/src/middleware/security-headers.ts`
- Create: `backend/src/lib/client-ip.ts`
- Create: `backend/src/middleware/rate-limit.ts`

- [ ] **Step 1: Write proxy secret middleware**

Create `backend/src/middleware/proxy-secret.ts`:
```typescript
import type { Request, Response, NextFunction } from "express";

const EXEMPT_PATHS = ["/api/internal/ebay-poll"];

export function proxySecret(req: Request, res: Response, next: NextFunction) {
  if (EXEMPT_PATHS.some((p) => req.path === p || req.path === p + "/")) {
    return next();
  }

  const secret = process.env.PROXY_SHARED_SECRET;
  if (!secret) {
    console.error("PROXY_SHARED_SECRET not configured");
    res.status(500).json({ error: "Server misconfigured" });
    return;
  }

  const provided = req.headers["x-proxy-secret"];
  if (provided !== secret) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  next();
}
```

- [ ] **Step 2: Write security headers middleware**

Create `backend/src/middleware/security-headers.ts`:
```typescript
import type { Request, Response, NextFunction } from "express";

export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cache-Control", "no-store");
  next();
}
```

- [ ] **Step 3: Write client IP helper**

Create `backend/src/lib/client-ip.ts`:
```typescript
import type { Request } from "express";

export function getClientIp(req: Request): string {
  const cfIp = req.headers["cf-connecting-ip"];
  if (typeof cfIp === "string") return cfIp;
  return req.ip || "unknown";
}
```

- [ ] **Step 4: Write rate limit config**

Create `backend/src/middleware/rate-limit.ts`:
```typescript
import rateLimit from "express-rate-limit";
import { getClientIp } from "../lib/client-ip.js";

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => getClientIp(req),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts, try again later" },
});

export const refreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => getClientIp(req),
  standardHeaders: true,
  legacyHeaders: false,
});

export const cronLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1,
  keyGenerator: (req) => getClientIp(req),
  standardHeaders: true,
  legacyHeaders: false,
});

export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  keyGenerator: (req) => getClientIp(req),
  standardHeaders: true,
  legacyHeaders: false,
});
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc -b --noEmit
```
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/middleware/proxy-secret.ts src/middleware/security-headers.ts src/middleware/rate-limit.ts src/lib/client-ip.ts
git commit -m "feat: add security middleware (proxy secret, headers, rate limiting)"
```

---

### Task 6: Auth System

**Files:**
- Create: `backend/src/middleware/auth.ts`
- Create: `backend/src/routes/auth.ts`
- Create: `backend/src/routes/auth.test.ts`

- [ ] **Step 1: Write auth middleware**

Create `backend/src/middleware/auth.ts`:
```typescript
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { getDb } from "../db/index.js";
import { settings } from "../db/schema.js";

interface JwtPayload {
  iat: number;
  exp: number;
  pv: number;
}

declare global {
  namespace Express {
    interface Request {
      authenticated?: boolean;
    }
  }
}

const EXEMPT_PATHS = [
  "/api/auth/verify",
  "/api/auth/refresh",
  "/api/auth/logout",
  "/api/ebay/callback",
  "/api/health",
];

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (EXEMPT_PATHS.some((p) => req.path === p || req.path === p + "/")) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const token = authHeader.slice(7);
  const signingKey = process.env.JWT_SIGNING_KEY;
  if (!signingKey) {
    res.status(500).json({ error: "Server misconfigured" });
    return;
  }

  try {
    const payload = jwt.verify(token, signingKey) as JwtPayload;
    // Check password version against DB
    checkPasswordVersion(payload.pv)
      .then((valid) => {
        if (!valid) {
          res.status(401).json({ error: "Token invalidated by password change" });
          return;
        }
        req.authenticated = true;
        next();
      })
      .catch(() => {
        res.status(500).json({ error: "Internal error" });
      });
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

async function checkPasswordVersion(pv: number): Promise<boolean> {
  const db = getDb();
  const [row] = await db.select({ passwordVersion: settings.passwordVersion }).from(settings).limit(1);
  if (!row) return false;
  return row.passwordVersion === pv;
}
```

- [ ] **Step 2: Write auth routes**

Create `backend/src/routes/auth.ts`:
```typescript
import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { getDb } from "../db/index.js";
import { settings, sessions } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import { validateBody, loginSchema, changePasswordSchema } from "../middleware/validate.js";
import { loginLimiter, refreshLimiter } from "../middleware/rate-limit.js";

const router = Router();

function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateAccessToken(passwordVersion: number): string {
  const key = process.env.JWT_SIGNING_KEY!;
  return jwt.sign({ pv: passwordVersion }, key, { expiresIn: "2h" });
}

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/api/auth",
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
};

// POST /api/auth/verify
router.post("/verify", loginLimiter, validateBody(loginSchema), async (req, res) => {
  try {
    const db = getDb();
    const [row] = await db.select().from(settings).limit(1);
    if (!row) {
      res.status(500).json({ error: "Settings not initialized" });
      return;
    }

    const valid = await bcrypt.compare(req.body.password, row.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Invalid password" });
      return;
    }

    const refreshToken = crypto.randomUUID();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await db.insert(sessions).values({ refreshTokenHash, expiresAt });

    const accessToken = generateAccessToken(row.passwordVersion);

    res.cookie("refresh_token", refreshToken, COOKIE_OPTIONS);
    res.json({ accessToken });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /api/auth/refresh
router.post("/refresh", refreshLimiter, async (req, res) => {
  try {
    const refreshToken = req.cookies?.refresh_token;
    if (!refreshToken) {
      res.status(401).json({ error: "No refresh token" });
      return;
    }

    const db = getDb();
    const hash = hashRefreshToken(refreshToken);
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, hash))
      .limit(1);

    if (!session || session.expiresAt < new Date()) {
      res.clearCookie("refresh_token", { path: "/api/auth" });
      res.status(401).json({ error: "Invalid or expired refresh token" });
      return;
    }

    const [settingsRow] = await db.select({ passwordVersion: settings.passwordVersion }).from(settings).limit(1);
    if (!settingsRow) {
      res.status(500).json({ error: "Settings not initialized" });
      return;
    }

    const accessToken = generateAccessToken(settingsRow.passwordVersion);
    res.json({ accessToken });
  } catch (err) {
    console.error("Refresh error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /api/auth/logout
router.post("/logout", async (req, res) => {
  try {
    const refreshToken = req.cookies?.refresh_token;
    if (refreshToken) {
      const db = getDb();
      const hash = hashRefreshToken(refreshToken);
      await db.delete(sessions).where(eq(sessions.refreshTokenHash, hash));
    }
    res.clearCookie("refresh_token", { path: "/api/auth" });
    res.json({ ok: true });
  } catch (err) {
    console.error("Logout error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /api/auth/change-password
router.post("/change-password", validateBody(changePasswordSchema), async (req, res) => {
  try {
    const db = getDb();
    const [row] = await db.select().from(settings).limit(1);
    if (!row) {
      res.status(500).json({ error: "Settings not initialized" });
      return;
    }

    const valid = await bcrypt.compare(req.body.currentPassword, row.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    const newHash = await bcrypt.hash(req.body.newPassword, 12);
    await db
      .update(settings)
      .set({
        passwordHash: newHash,
        passwordVersion: sql`${settings.passwordVersion} + 1`,
      })
      .where(eq(settings.id, row.id));

    // Revoke all sessions
    await db.delete(sessions);

    res.clearCookie("refresh_token", { path: "/api/auth" });
    res.json({ ok: true });
  } catch (err) {
    console.error("Change password error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc -b --noEmit
```
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/middleware/auth.ts src/routes/auth.ts
git commit -m "feat: add auth system (JWT + refresh tokens + password change)"
```

---

### Task 7: Inventory Service (Transactional Mutations)

**Files:**
- Create: `backend/src/services/inventory.ts`
- Create: `backend/src/services/inventory.test.ts`

- [ ] **Step 1: Write the inventory service**

Create `backend/src/services/inventory.ts`:
```typescript
import { getDb } from "../db/index.js";
import { parts, inventoryEvents } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import { normalizePartNumber } from "./normalize.js";

interface AddPartInput {
  partNumber: string;
  brand?: string;
  description?: string;
  quantity: number;
  note?: string;
}

interface DepletePartInput {
  partId: number;
  quantity: number;
  reason: "used" | "sold";
  note?: string;
}

export async function addPart(input: AddPartInput) {
  const db = getDb();
  const normalized = normalizePartNumber(input.partNumber);

  return await db.transaction(async (tx) => {
    // Try to find existing part with row lock
    const [existing] = await tx
      .select()
      .from(parts)
      .where(eq(parts.partNumber, normalized))
      .for("update");

    let partId: number;

    if (existing) {
      // Upsert: increment quantity, optionally update metadata
      await tx
        .update(parts)
        .set({
          quantity: sql`${parts.quantity} + ${input.quantity}`,
          ...(input.brand !== undefined && { brand: input.brand }),
          ...(input.description !== undefined && { description: input.description }),
          updatedAt: new Date(),
        })
        .where(eq(parts.id, existing.id));
      partId = existing.id;
    } else {
      // Insert new part
      const [newPart] = await tx
        .insert(parts)
        .values({
          partNumber: normalized,
          partNumberRaw: input.partNumber.trim(),
          brand: input.brand,
          description: input.description,
          quantity: input.quantity,
        })
        .returning({ id: parts.id });
      partId = newPart.id;
    }

    // Always create inventory event
    await tx.insert(inventoryEvents).values({
      partId,
      eventType: "added",
      quantityChange: input.quantity,
      note: input.note,
    });

    // Return the updated/created part
    const [result] = await tx.select().from(parts).where(eq(parts.id, partId));
    return result;
  });
}

export async function depletePart(input: DepletePartInput) {
  const db = getDb();

  return await db.transaction(async (tx) => {
    const [part] = await tx
      .select()
      .from(parts)
      .where(eq(parts.id, input.partId))
      .for("update");

    if (!part) {
      throw new Error("Part not found");
    }

    const available = part.quantity - part.listedQuantity;
    if (input.quantity > available) {
      throw new Error(`Cannot deplete ${input.quantity} — only ${available} available (${part.listedQuantity} listed on eBay)`);
    }

    await tx
      .update(parts)
      .set({
        quantity: sql`${parts.quantity} - ${input.quantity}`,
        updatedAt: new Date(),
      })
      .where(eq(parts.id, part.id));

    await tx.insert(inventoryEvents).values({
      partId: part.id,
      eventType: input.reason,
      quantityChange: -input.quantity,
      note: input.note,
    });

    const [result] = await tx.select().from(parts).where(eq(parts.id, part.id));
    return result;
  });
}

export async function updatePartMetadata(partId: number, data: {
  brand?: string;
  description?: string;
  ebayListingId?: string | null;
  listedQuantity?: number;
}) {
  const db = getDb();

  return await db.transaction(async (tx) => {
    const [part] = await tx
      .select()
      .from(parts)
      .where(eq(parts.id, partId))
      .for("update");

    if (!part) {
      throw new Error("Part not found");
    }

    // Validate listing invariants if listedQuantity is being changed
    const newListedQty = data.listedQuantity ?? part.listedQuantity;
    const newEbayId = data.ebayListingId !== undefined ? data.ebayListingId : part.ebayListingId;

    if (newListedQty < 0 || newListedQty > part.quantity) {
      throw new Error(`listed_quantity must be between 0 and ${part.quantity}`);
    }
    if (newListedQty > 0 && !newEbayId) {
      throw new Error("ebay_listing_id required when listed_quantity > 0");
    }
    if (newListedQty === 0 && newEbayId) {
      throw new Error("ebay_listing_id must be null when listed_quantity is 0");
    }

    await tx
      .update(parts)
      .set({
        ...(data.brand !== undefined && { brand: data.brand }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.ebayListingId !== undefined && { ebayListingId: data.ebayListingId }),
        ...(data.listedQuantity !== undefined && { listedQuantity: data.listedQuantity }),
        updatedAt: new Date(),
      })
      .where(eq(parts.id, partId));

    const [result] = await tx.select().from(parts).where(eq(parts.id, partId));
    return result;
  });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc -b --noEmit
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/services/inventory.ts
git commit -m "feat: add transactional inventory service with row locking"
```

---

### Task 8: Parts Routes

**Files:**
- Create: `backend/src/routes/parts.ts`

- [ ] **Step 1: Write parts routes**

Create `backend/src/routes/parts.ts`:
```typescript
import { Router } from "express";
import { getDb } from "../db/index.js";
import { parts, crossReferences, inventoryEvents } from "../db/schema.js";
import { eq, ilike, sql, desc, or, and, gt } from "drizzle-orm";
import { validateBody, addPartSchema, depletePartSchema, updatePartSchema } from "../middleware/validate.js";
import { addPart, depletePart, updatePartMetadata } from "../services/inventory.js";
import { normalizePartNumber } from "../services/normalize.js";

const router = Router();

// GET /api/parts — list all, optional search
router.get("/", async (req, res) => {
  try {
    const db = getDb();
    const search = typeof req.query.search === "string" ? req.query.search : undefined;

    let query = db.select().from(parts);
    if (search) {
      const normalized = normalizePartNumber(search);
      query = query.where(ilike(parts.partNumber, `%${normalized}%`)) as typeof query;
    }

    const results = await query.orderBy(desc(parts.updatedAt));
    res.json(results.map(partToJson));
  } catch (err) {
    console.error("List parts error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/parts/lookup — main lookup endpoint
router.get("/lookup", async (req, res) => {
  try {
    const partNumber = typeof req.query.partNumber === "string" ? req.query.partNumber : "";
    if (!partNumber) {
      res.status(400).json({ error: "partNumber query param required" });
      return;
    }

    const db = getDb();
    const normalized = normalizePartNumber(partNumber);

    // Find exact match
    const [exactMatch] = await db
      .select()
      .from(parts)
      .where(eq(parts.partNumber, normalized))
      .limit(1);

    // Find alternatives via cross-references (both directions)
    const alternatives = await findAlternatives(db, normalized);

    res.json({
      exact: exactMatch ? partToJson(exactMatch) : null,
      alternatives,
    });
  } catch (err) {
    console.error("Lookup error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/parts/:id — single part with cross-refs and events
router.get("/:id(\\d+)", async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);

    const [part] = await db.select().from(parts).where(eq(parts.id, id)).limit(1);
    if (!part) {
      res.status(404).json({ error: "Part not found" });
      return;
    }

    // Get cross-references
    const crossRefs = await db
      .select()
      .from(crossReferences)
      .where(eq(crossReferences.partId, part.id));

    // Check which cross-ref parts are in stock
    const crossRefsWithStock = await Promise.all(
      crossRefs.map(async (ref) => {
        const normalized = normalizePartNumber(ref.crossRefPartNumber);
        const [stockPart] = await db
          .select({ quantity: parts.quantity })
          .from(parts)
          .where(eq(parts.partNumber, normalized))
          .limit(1);
        return {
          crossRefPartNumber: ref.crossRefPartNumber,
          relationship: ref.relationship,
          inStock: !!stockPart && stockPart.quantity > 0,
          quantity: stockPart?.quantity ?? 0,
        };
      })
    );

    // Get events (paginated)
    const limit = parseInt(String(req.query.eventsLimit)) || 20;
    const offset = parseInt(String(req.query.eventsOffset)) || 0;

    const events = await db
      .select()
      .from(inventoryEvents)
      .where(eq(inventoryEvents.partId, id))
      .orderBy(desc(inventoryEvents.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({
      part: partToJson(part),
      crossReferences: crossRefsWithStock,
      events: events.map(eventToJson),
    });
  } catch (err) {
    console.error("Get part error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

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

// PATCH /api/parts/:id — update metadata only
router.patch("/:id(\\d+)", validateBody(updatePartSchema), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const result = await updatePartMetadata(id, req.body);
    res.json(partToJson(result));
  } catch (err: any) {
    if (err.message?.includes("not found")) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err.message?.includes("must be") || err.message?.includes("required")) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Update part error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /api/parts/:id/deplete
router.post("/:id(\\d+)/deplete", validateBody(depletePartSchema), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const result = await depletePart({
      partId: id,
      quantity: req.body.quantity,
      reason: req.body.reason,
    });
    res.json(partToJson(result));
  } catch (err: any) {
    if (err.message?.includes("not found")) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err.message?.includes("Cannot deplete")) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Deplete part error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// --- Helpers ---

function partToJson(p: typeof parts.$inferSelect) {
  return {
    id: p.id,
    partNumber: p.partNumber,
    partNumberRaw: p.partNumberRaw,
    brand: p.brand,
    description: p.description,
    quantity: p.quantity,
    listedQuantity: p.listedQuantity,
    available: p.quantity - p.listedQuantity,
    ebayListingId: p.ebayListingId,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function eventToJson(e: typeof inventoryEvents.$inferSelect) {
  return {
    id: e.id,
    eventType: e.eventType,
    quantityChange: e.quantityChange,
    note: e.note,
    createdAt: e.createdAt.toISOString(),
  };
}

async function findAlternatives(db: ReturnType<typeof getDb>, normalizedPartNumber: string) {
  // Get the part's ID if it exists
  const [part] = await db
    .select({ id: parts.id })
    .from(parts)
    .where(eq(parts.partNumber, normalizedPartNumber))
    .limit(1);

  if (!part) return [];

  // Forward: parts this one references
  const forward = await db
    .select({ crossRefPartNumber: crossReferences.crossRefPartNumber, relationship: crossReferences.relationship })
    .from(crossReferences)
    .where(eq(crossReferences.partId, part.id));

  // Reverse: parts that reference this one
  const reverse = await db
    .select({ partId: crossReferences.partId, relationship: crossReferences.relationship })
    .from(crossReferences)
    .where(eq(crossReferences.crossRefPartNumber, normalizedPartNumber));

  // Deduplicate by normalized part number
  const seen = new Set<string>([normalizedPartNumber]);
  const alternatives: Array<{ partNumber: string; relationship: string; quantity: number; available: number }> = [];

  for (const ref of forward) {
    const norm = normalizePartNumber(ref.crossRefPartNumber);
    if (seen.has(norm)) continue;
    seen.add(norm);

    const [stockPart] = await db.select().from(parts).where(eq(parts.partNumber, norm)).limit(1);
    if (stockPart && stockPart.quantity > 0) {
      alternatives.push({
        partNumber: stockPart.partNumber,
        relationship: ref.relationship,
        quantity: stockPart.quantity,
        available: stockPart.quantity - stockPart.listedQuantity,
      });
    }
  }

  for (const ref of reverse) {
    const [refPart] = await db.select().from(parts).where(eq(parts.id, ref.partId)).limit(1);
    if (!refPart) continue;
    if (seen.has(refPart.partNumber)) continue;
    seen.add(refPart.partNumber);

    if (refPart.quantity > 0) {
      alternatives.push({
        partNumber: refPart.partNumber,
        relationship: ref.relationship,
        quantity: refPart.quantity,
        available: refPart.quantity - refPart.listedQuantity,
      });
    }
  }

  return alternatives;
}

export default router;
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc -b --noEmit
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/routes/parts.ts
git commit -m "feat: add parts routes (CRUD, lookup, deplete)"
```

---

### Task 9: Settings & Health Routes

**Files:**
- Create: `backend/src/routes/settings.ts`
- Create: `backend/src/routes/health.ts`

- [ ] **Step 1: Write settings routes**

Create `backend/src/routes/settings.ts`:
```typescript
import { Router } from "express";
import { getDb } from "../db/index.js";
import { settings, ebayProcessedOrders } from "../db/schema.js";
import { eq, isNotNull, sql } from "drizzle-orm";
import { validateBody, updateSettingsSchema } from "../middleware/validate.js";

const router = Router();

// GET /api/settings
router.get("/", async (req, res) => {
  try {
    const db = getDb();
    const [row] = await db.select().from(settings).limit(1);
    if (!row) {
      res.status(500).json({ error: "Settings not initialized" });
      return;
    }

    const [quarantine] = await db
      .select({ count: sql<number>`count(*)` })
      .from(ebayProcessedOrders)
      .where(isNotNull(ebayProcessedOrders.quarantineReason));

    res.json({
      crossRefEnabled: row.crossRefEnabled,
      darkMode: row.darkMode,
      ebay: {
        enabled: row.ebayEnabled,
        connected: !!row.ebayRefreshToken,
        quarantinedCount: Number(quarantine.count),
      },
    });
  } catch (err) {
    console.error("Get settings error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// PUT /api/settings
router.put("/", validateBody(updateSettingsSchema), async (req, res) => {
  try {
    const db = getDb();
    const [row] = await db.select().from(settings).limit(1);
    if (!row) {
      res.status(500).json({ error: "Settings not initialized" });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (req.body.crossRefEnabled !== undefined) updates.crossRefEnabled = req.body.crossRefEnabled;
    if (req.body.darkMode !== undefined) updates.darkMode = req.body.darkMode;
    if (req.body.ebayEnabled !== undefined) updates.ebayEnabled = req.body.ebayEnabled;

    if (Object.keys(updates).length > 0) {
      await db.update(settings).set(updates).where(eq(settings.id, row.id));
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Update settings error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
```

- [ ] **Step 2: Write health route**

Create `backend/src/routes/health.ts`:
```typescript
import { Router } from "express";

const router = Router();

router.get("/", (_req, res) => {
  res.json({ status: "ok" });
});

export default router;
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc -b --noEmit
```
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/routes/settings.ts src/routes/health.ts
git commit -m "feat: add settings and health routes"
```

---

### Task 10: Express App Entry Point

**Files:**
- Create: `backend/src/index.ts`
- Create: `backend/src/db/seed.ts`

- [ ] **Step 1: Write the seed script**

Create `backend/src/db/seed.ts`:
```typescript
import bcrypt from "bcrypt";
import { getDb } from "./index.js";
import { settings } from "./schema.js";

export async function seedSettings(defaultPassword: string) {
  const db = getDb();
  const [existing] = await db.select().from(settings).limit(1);
  if (existing) return; // Already seeded

  const hash = await bcrypt.hash(defaultPassword, 12);
  await db.insert(settings).values({
    passwordHash: hash,
  });
  console.log("Settings row seeded with default password");
}
```

- [ ] **Step 2: Write the Express app**

Create `backend/src/index.ts`:
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
import { generalLimiter } from "./middleware/rate-limit.js";
import healthRouter from "./routes/health.js";
import authRouter from "./routes/auth.js";
import partsRouter from "./routes/parts.js";
import settingsRouter from "./routes/settings.js";

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

// Auth middleware — applies to everything below
app.use(authMiddleware);

// Rate limit all authenticated routes
app.use(generalLimiter);

// Application routes
app.use("/api/parts", partsRouter);
app.use("/api/settings", settingsRouter);

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

- [ ] **Step 3: Install cookie-parser**

```bash
npm install cookie-parser
npm install -D @types/cookie-parser
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc -b --noEmit
```
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/db/seed.ts
git commit -m "feat: add Express app entry point with middleware chain"
```

---

### Task 11: Generate Initial Migration

**Files:**
- Create: `backend/drizzle/` (migration files auto-generated)

- [ ] **Step 1: Create a .env file for local development**

Create `backend/.env` (do NOT commit):
```
DATABASE_URL=your-neon-connection-string
JWT_SIGNING_KEY=dev-jwt-signing-key-at-least-32-chars
DATA_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
PROXY_SHARED_SECRET=dev-proxy-secret
INTERNAL_CRON_SECRET=dev-cron-secret-must-be-at-least-64-characters-long-for-security-purposes
DEFAULT_PASSWORD=changeme
PORT=3000
```

- [ ] **Step 2: Generate migration**

```bash
npx drizzle-kit generate
```
Expected: creates migration SQL files in `backend/drizzle/`

- [ ] **Step 3: Verify migration files exist**

```bash
ls drizzle/
```
Expected: at least one `.sql` file and a `meta/` directory with `_journal.json` and snapshot

- [ ] **Step 4: Verify journal entry exists**

```bash
cat drizzle/meta/_journal.json
```
Expected: JSON with at least one entry (per Drizzle gotcha in knowledge docs)

- [ ] **Step 5: Add .env to .gitignore**

Create `backend/.gitignore`:
```
node_modules/
dist/
.env
```

- [ ] **Step 6: Commit**

```bash
git add drizzle/ backend/.gitignore
git commit -m "feat: generate initial database migration"
```

---

### Task 12: Local Smoke Test

**Files:** none new — this tests the assembled system

- [ ] **Step 1: Run the migration against Neon**

```bash
cd /Users/alexk/Documents/AntiGravity/Part-Tracker/backend
npx tsx src/db/migrate.ts
```
Expected: "Migrations complete" (or similar Drizzle output)

- [ ] **Step 2: Start the server**

```bash
npx tsx src/index.ts
```
Expected: "Migrations complete" then "Server running on port 3000"

- [ ] **Step 3: Test health endpoint**

In a new terminal:
```bash
curl http://localhost:3000/api/health
```
Expected: `{"status":"ok"}`

- [ ] **Step 4: Test login**

```bash
curl -X POST http://localhost:3000/api/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"password":"changeme"}' \
  -c cookies.txt -v
```
Expected: 200 with `{"accessToken":"..."}` and a `Set-Cookie` header with `refresh_token`

- [ ] **Step 5: Test adding a part**

Extract the access token from step 4, then:
```bash
curl -X POST http://localhost:3000/api/parts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -d '{"partNumber":"WP-W10321304","brand":"Whirlpool","quantity":3,"note":"From Kenmore #2847"}'
```
Expected: 201 with the created part (partNumber normalized to "WPW10321304")

- [ ] **Step 6: Test listing parts**

```bash
curl http://localhost:3000/api/parts \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```
Expected: array with 1 part

- [ ] **Step 7: Test depleting**

```bash
curl -X POST http://localhost:3000/api/parts/1/deplete \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -d '{"quantity":1,"reason":"used"}'
```
Expected: 200 with part showing quantity 2

- [ ] **Step 8: Test part detail with events**

```bash
curl http://localhost:3000/api/parts/1 \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```
Expected: part data + events array showing "added" (+3) and "used" (-1)

- [ ] **Step 9: Stop server, commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: smoke test adjustments" --allow-empty
```

---

### Task 13: AES-256-GCM Crypto Stub

**Files:**
- Create: `backend/src/services/crypto.ts`
- Create: `backend/src/services/crypto.test.ts`

This is needed by the eBay integration plan but we implement the utility here since it's a core service.

- [ ] **Step 1: Write failing tests**

Create `backend/src/services/crypto.test.ts`:
```typescript
import { describe, it } from "node:test";
import * as assert from "node:assert";

// Set env before import
process.env.DATA_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { encrypt, decrypt } = await import("./crypto.js");

describe("AES-256-GCM crypto", () => {
  it("round-trips a string", () => {
    const plaintext = "my-secret-token-value";
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);
    assert.strictEqual(decrypted, plaintext);
  });

  it("produces different ciphertext each time (unique nonces)", () => {
    const plaintext = "same-input";
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    assert.notStrictEqual(a, b);
  });

  it("encrypted format is nonce:ciphertext:tag", () => {
    const encrypted = encrypt("test");
    const parts = encrypted.split(":");
    assert.strictEqual(parts.length, 3);
  });

  it("rejects tampered ciphertext", () => {
    const encrypted = encrypt("test");
    const parts = encrypted.split(":");
    // Flip a character in the ciphertext
    const tampered = parts[0] + ":" + "X" + parts[1].slice(1) + ":" + parts[2];
    assert.throws(() => decrypt(tampered));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsx --test src/services/crypto.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `backend/src/services/crypto.ts`:
```typescript
import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const hex = process.env.DATA_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("DATA_ENCRYPTION_KEY must be a 64-character hex string (256 bits)");
  }
  return Buffer.from(hex, "hex");
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${nonce.toString("base64")}:${encrypted.toString("base64")}:${tag.toString("base64")}`;
}

export function decrypt(encoded: string): string {
  const key = getKey();
  const [nonceB64, ciphertextB64, tagB64] = encoded.split(":");

  const nonce = Buffer.from(nonceB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const tag = Buffer.from(tagB64, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}
```

- [ ] **Step 4: Run tests**

```bash
npx tsx --test src/services/crypto.test.ts
```
Expected: PASS — all 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/services/crypto.ts src/services/crypto.test.ts
git commit -m "feat: add AES-256-GCM encrypt/decrypt for token storage"
```

---

## Self-Review

**Spec coverage check:**
- [x] Database schema (all 7 tables) — Task 2
- [x] Part number normalization — Task 3
- [x] Input validation (string lengths + numeric/domain) — Task 4
- [x] Proxy secret middleware — Task 5
- [x] Security headers — Task 5
- [x] Rate limiting — Task 5
- [x] Client IP extraction — Task 5
- [x] Auth (JWT + refresh + logout + change-password) — Task 6
- [x] Inventory mutations (transactional, row-locked) — Task 7
- [x] Parts CRUD + lookup + deplete — Task 8
- [x] Settings GET/PUT — Task 9
- [x] Health endpoint — Task 9
- [x] App entry + migration + seed — Task 10
- [x] Migration generation — Task 11
- [x] Smoke test — Task 12
- [x] AES-256-GCM crypto — Task 13
- [ ] eBay routes (auth-url, callback, disconnect, poll, quarantine) — **Deferred to Plan 2: Integrations**
- [ ] Cross-reference web search — **Deferred to Plan 2: Integrations**
- [ ] Frontend — **Deferred to Plan 3: Frontend**

**Placeholder scan:** No TBD, TODO, or "implement later" found.

**Type consistency:** `partToJson`, `eventToJson` helpers match the schema types. Validation schemas match route handlers. Auth middleware uses consistent `pv` claim name.
