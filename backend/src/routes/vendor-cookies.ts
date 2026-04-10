import { Router } from "express";
import { getDb } from "../db/index.js";
import { vendorCookies } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { requireScope } from "../middleware/auth.js";
import { validateBody, cookieUploadSchema, cookieUpdateSchema } from "../middleware/validate.js";
import {
  parseCookiesTxt,
  normalizeDomain,
  normalizeCookieInput,
  encryptCookies,
  decryptCookies,
  getAuthCookieExpiry,
} from "../services/cookies.js";

const router = Router();

// GET /api/vendor-cookies -- list all (metadata only)
router.get("/", requireScope("parts:read"), async (_req, res) => {
  try {
    const db = getDb();
    const rows = await db.select().from(vendorCookies);

    const result = rows.map((row) => {
      let cookieCount = 0;
      try {
        const txt = decryptCookies(row.cookieData);
        cookieCount = parseCookiesTxt(txt).length;
      } catch {
        // If decryption fails, cookie count stays 0
      }

      let expiryWarning: string | null = null;
      if (row.authCookieExpiry) {
        const ms = row.authCookieExpiry.getTime() - Date.now();
        if (ms < 0) expiryWarning = "Auth cookies may have expired";
        else if (ms < 24 * 60 * 60 * 1000) expiryWarning = "Auth cookies expire within 24 hours";
        else if (ms < 7 * 24 * 60 * 60 * 1000) {
          const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
          expiryWarning = `Auth cookies expire in ${days} day${days > 1 ? "s" : ""}`;
        }
      }

      return {
        id: row.id,
        vendorName: row.vendorName,
        domain: row.domain,
        isPreset: row.isPreset,
        status: row.status,
        cookieCount,
        authCookieExpiry: row.authCookieExpiry?.toISOString() ?? null,
        expiryWarning,
        lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
      };
    });

    res.json(result);
  } catch (err) {
    console.error("List vendor cookies error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /api/vendor-cookies -- upload cookies for a vendor
router.post("/", requireScope("parts:write"), validateBody(cookieUploadSchema), async (req, res) => {
  try {
    const { vendorName, domain: rawDomain, cookiesTxt, isPreset } = req.body as {
      vendorName: string;
      domain: string;
      cookiesTxt: string;
      isPreset?: boolean;
    };

    const domain = normalizeDomain(rawDomain);
    const normalized = normalizeCookieInput(cookiesTxt, domain);
    const cookies = parseCookiesTxt(normalized);
    if (cookies.length === 0) {
      res.status(400).json({ error: "No valid cookies found. Accepted formats: cookies.txt, JSON array, JSON object, or Cookie header string." });
      return;
    }

    const encrypted = encryptCookies(normalized);
    const authExpiry = getAuthCookieExpiry(cookies, domain);

    const db = getDb();
    const now = new Date();

    // Upsert by domain
    const [existing] = await db
      .select({ id: vendorCookies.id })
      .from(vendorCookies)
      .where(eq(vendorCookies.domain, domain))
      .limit(1);

    if (existing) {
      await db
        .update(vendorCookies)
        .set({
          vendorName,
          cookieData: encrypted,
          authCookieExpiry: authExpiry,
          status: "active",
          updatedAt: now,
        })
        .where(eq(vendorCookies.id, existing.id));
    } else {
      await db.insert(vendorCookies).values({
        vendorName,
        domain,
        cookieData: encrypted,
        authCookieExpiry: authExpiry,
        isPreset: isPreset ?? false,
        status: "active",
      });
    }

    res.status(201).json({
      cookieCount: cookies.length,
      domain,
      authCookieExpiry: authExpiry?.toISOString() ?? null,
    });
  } catch (err) {
    console.error("Upload cookies error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// PUT /api/vendor-cookies/:id -- update cookies
router.put("/:id", requireScope("parts:write"), validateBody(cookieUpdateSchema), async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt((req.params as Record<string, string>)["id"], 10);
    const { cookiesTxt } = req.body as { cookiesTxt: string };

    const [existing] = await db
      .select()
      .from(vendorCookies)
      .where(eq(vendorCookies.id, id))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Vendor cookies not found" });
      return;
    }

    const normalized = normalizeCookieInput(cookiesTxt, existing.domain);
    const cookies = parseCookiesTxt(normalized);
    if (cookies.length === 0) {
      res.status(400).json({ error: "No valid cookies found. Accepted formats: cookies.txt, JSON array, JSON object, or Cookie header string." });
      return;
    }

    const encrypted = encryptCookies(normalized);
    const authExpiry = getAuthCookieExpiry(cookies, existing.domain);

    await db
      .update(vendorCookies)
      .set({
        cookieData: encrypted,
        authCookieExpiry: authExpiry,
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(vendorCookies.id, id));

    res.json({ cookieCount: cookies.length, authCookieExpiry: authExpiry?.toISOString() ?? null });
  } catch (err) {
    console.error("Update cookies error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// DELETE /api/vendor-cookies/:id
router.delete("/:id", requireScope("parts:write"), async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt((req.params as Record<string, string>)["id"], 10);

    const [existing] = await db
      .select({ id: vendorCookies.id, isPreset: vendorCookies.isPreset })
      .from(vendorCookies)
      .where(eq(vendorCookies.id, id))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Vendor cookies not found" });
      return;
    }

    if (existing.isPreset) {
      // Preset vendors get cleared, not deleted
      await db
        .update(vendorCookies)
        .set({
          cookieData: "",
          authCookieExpiry: null,
          status: "unconfigured",
          lastTestedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(vendorCookies.id, id));
    } else {
      await db.delete(vendorCookies).where(eq(vendorCookies.id, id));
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Delete cookies error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
