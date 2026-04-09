import { Router } from "express";
import crypto from "node:crypto";
import { getDb } from "../db/index.js";
import { settings, ebayProcessedOrders, ebayPollWatermark } from "../db/schema.js";
import { eq, isNotNull, desc, sql } from "drizzle-orm";
import { encrypt } from "../services/crypto.js";
import { buildAuthUrl, exchangeCodeForTokens } from "../services/ebay.js";
import { ebayCallbackLimiter } from "../middleware/rate-limit.js";
import { invalidateSettingsSummaryCache } from "../services/settings-summary.js";

const router = Router();

// POST /api/ebay/auth-url
router.post("/auth-url", async (req, res) => {
  try {
    const db = getDb();
    const state = crypto.randomBytes(32).toString("hex");
    const stateExpires = new Date(Date.now() + 10 * 60 * 1000);

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

// GET /api/ebay/callback — OAuth callback (exempt from JWT auth)
router.get("/callback", ebayCallbackLimiter, async (req, res) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";

    if (!code || !state) {
      res.status(400).send("Missing code or state parameter");
      return;
    }

    const db = getDb();

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

    const tokens = await exchangeCodeForTokens(code);
    const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);

    await db
      .update(settings)
      .set({
        ebayAccessToken: encrypt(tokens.accessToken),
        ebayRefreshToken: encrypt(tokens.refreshToken),
        ebayTokenExpiresAt: expiresAt,
        ebayEnabled: true,
      })
      .where(eq(settings.id, 1));
    invalidateSettingsSummaryCache();

    const [existingWatermark] = await db.select().from(ebayPollWatermark).limit(1);
    if (!existingWatermark) {
      await db.insert(ebayPollWatermark).values({
        lastPolledAt: new Date(),
      });
    }

    res.redirect("/settings?ebay=connected");
  } catch (err) {
    console.error("eBay callback error:", err);
    res.redirect("/settings?ebay=error");
  }
});

// POST /api/ebay/disconnect
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
    invalidateSettingsSummaryCache();

    res.json({ ok: true });
  } catch (err) {
    console.error("eBay disconnect error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/ebay/quarantine
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
