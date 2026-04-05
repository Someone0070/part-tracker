import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
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
      apiKeyScopes?: string[];
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

  // Check for API key first
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.length > 0) {
    validateApiKey(apiKey)
      .then((scopes) => {
        if (!scopes) {
          res.status(401).json({ error: "Invalid API key" });
          return;
        }
        req.authenticated = true;
        req.apiKeyScopes = scopes;
        next();
      })
      .catch(() => {
        res.status(500).json({ error: "Internal error" });
      });
    return;
  }

  // Fall back to JWT
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

export function requireScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    // JWT users (no apiKeyScopes) have full access
    if (!req.apiKeyScopes) {
      next();
      return;
    }
    if (req.apiKeyScopes.includes(scope)) {
      next();
      return;
    }
    res.status(403).json({ error: `Missing scope: ${scope}` });
  };
}

async function validateApiKey(key: string): Promise<string[] | null> {
  const db = getDb();
  const [row] = await db
    .select({
      apiKeyHash: settings.apiKeyHash,
      apiKeyScopes: settings.apiKeyScopes,
    })
    .from(settings)
    .limit(1);

  if (!row?.apiKeyHash) return null;

  const hash = crypto.createHash("sha256").update(key).digest("hex");
  if (hash !== row.apiKeyHash) return null;

  try {
    return JSON.parse(row.apiKeyScopes || "[]");
  } catch {
    return [];
  }
}

async function checkPasswordVersion(pv: number): Promise<boolean> {
  const db = getDb();
  const [row] = await db.select({ passwordVersion: settings.passwordVersion }).from(settings).limit(1);
  if (!row) return false;
  return row.passwordVersion === pv;
}
