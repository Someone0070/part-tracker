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
