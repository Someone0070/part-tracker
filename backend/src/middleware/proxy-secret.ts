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
