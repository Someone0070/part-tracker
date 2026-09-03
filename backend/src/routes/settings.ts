import { Router } from "express";
import crypto from "crypto";
import { getDb } from "../db/index.js";
import { invalidateAuthCache } from "../middleware/auth.js";
import { imageUploadAttempts, settings } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { validateBody, updateSettingsSchema } from "../middleware/validate.js";
import { cacheControl } from "../middleware/timing.js";
import {
  getCachedSettingsSnapshot,
  invalidateSettingsSummaryCache,
  toPublicSettingsSummary,
} from "../services/settings-summary.js";

const router = Router();

// GET /api/settings — cached for 30s (private, user-specific)
router.get("/", cacheControl(30), async (req, res) => {
  try {
    const snapshot = await getCachedSettingsSnapshot();
    if (!snapshot) {
      res.status(500).json({ error: "Settings not initialized" });
      return;
    }

    res.json(toPublicSettingsSummary(snapshot));
  } catch (err) {
    console.error("Get settings error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/settings/image-attempts/summary — privacy-safe upload health counts
router.get("/image-attempts/summary", cacheControl(30), async (req, res) => {
  try {
    const requestedDays = Number(req.query.days);
    const days = Number.isInteger(requestedDays) ? Math.min(90, Math.max(1, requestedDays)) : 7;
    const rows = await getDb()
      .select({
        kind: imageUploadAttempts.kind,
        status: imageUploadAttempts.status,
        errorCategory: imageUploadAttempts.errorCategory,
        count: sql<number>`count(*)::int`,
      })
      .from(imageUploadAttempts)
      .where(sql`${imageUploadAttempts.createdAt} >= now() - (${days} * interval '1 day')`)
      .groupBy(imageUploadAttempts.kind, imageUploadAttempts.status, imageUploadAttempts.errorCategory);

    const total = rows.reduce((sum, row) => sum + Number(row.count), 0);
    const failed = rows
      .filter((row) => row.status === "failed")
      .reduce((sum, row) => sum + Number(row.count), 0);
    res.json({ days, total, succeeded: total - failed, failed, breakdown: rows });
  } catch (error) {
    console.error("Image attempt summary error:", error);
    res.status(500).json({ error: "Could not load image upload health" });
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
      invalidateSettingsSummaryCache();
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Update settings error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

const VALID_SCOPES = ["parts:read", "parts:write", "appliances:read", "appliances:write"];

// POST /api/settings/api-key — generate or regenerate API key
router.post("/api-key", async (req, res) => {
  try {
    const { scopes } = req.body as { scopes?: string[] };
    if (!Array.isArray(scopes) || scopes.length === 0) {
      res.status(400).json({ error: "At least one scope is required" });
      return;
    }
    const invalid = scopes.filter((s) => !VALID_SCOPES.includes(s));
    if (invalid.length > 0) {
      res.status(400).json({ error: `Invalid scopes: ${invalid.join(", ")}` });
      return;
    }

    const db = getDb();
    const [row] = await db.select({ id: settings.id }).from(settings).limit(1);
    if (!row) {
      res.status(500).json({ error: "Settings not initialized" });
      return;
    }

    const key = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(key).digest("hex");
    const prefix = key.slice(0, 8);

    await db
      .update(settings)
      .set({
        apiKeyHash: hash,
        apiKeyPrefix: prefix,
        apiKeyScopes: JSON.stringify(scopes),
      })
      .where(eq(settings.id, row.id));

    invalidateAuthCache();
    invalidateSettingsSummaryCache();
    res.json({ key, prefix, scopes });
  } catch (err) {
    console.error("Generate API key error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// DELETE /api/settings/api-key — revoke API key
router.delete("/api-key", async (req, res) => {
  try {
    const db = getDb();
    const [row] = await db.select({ id: settings.id }).from(settings).limit(1);
    if (!row) {
      res.status(500).json({ error: "Settings not initialized" });
      return;
    }

    await db
      .update(settings)
      .set({
        apiKeyHash: null,
        apiKeyPrefix: null,
        apiKeyScopes: null,
      })
      .where(eq(settings.id, row.id));

    invalidateAuthCache();
    invalidateSettingsSummaryCache();
    res.json({ ok: true });
  } catch (err) {
    console.error("Revoke API key error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
