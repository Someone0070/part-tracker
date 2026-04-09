import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { getDb } from "../db/index.js";
import { invalidateAuthCache } from "../middleware/auth.js";
import { settings, sessions } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import { validateBody, loginSchema, changePasswordSchema } from "../middleware/validate.js";
import { loginLimiter, refreshLimiter } from "../middleware/rate-limit.js";
import {
  getCachedSettingsSnapshot,
  invalidateSettingsSummaryCache,
  toPublicSettingsSummary,
} from "../services/settings-summary.js";

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
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

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
    const settingsSnapshot = await getCachedSettingsSnapshot();
    if (!settingsSnapshot) {
      res.status(500).json({ error: "Settings not initialized" });
      return;
    }

    res.cookie("refresh_token", refreshToken, COOKIE_OPTIONS);
    res.json({
      accessToken,
      settings: toPublicSettingsSummary(settingsSnapshot),
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

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

    const settingsSnapshot = await getCachedSettingsSnapshot();
    if (!settingsSnapshot) {
      res.status(500).json({ error: "Settings not initialized" });
      return;
    }

    const accessToken = generateAccessToken(settingsSnapshot.passwordVersion);
    res.json({
      accessToken,
      settings: toPublicSettingsSummary(settingsSnapshot),
    });
  } catch (err) {
    console.error("Refresh error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

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

    await db.delete(sessions);
    invalidateAuthCache();
    invalidateSettingsSummaryCache();

    res.clearCookie("refresh_token", { path: "/api/auth" });
    res.json({ ok: true });
  } catch (err) {
    console.error("Change password error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
