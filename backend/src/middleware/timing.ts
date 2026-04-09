import type { Request, Response, NextFunction } from "express";

const SLOW_THRESHOLD_MS = 500;

export function timingMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = performance.now();

  res.on("finish", () => {
    const duration = Math.round(performance.now() - start);
    // Log slow requests
    if (duration >= SLOW_THRESHOLD_MS) {
      console.warn(`SLOW ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
    }
    // Always set Server-Timing header for client observability
    res.setHeader("Server-Timing", `total;dur=${duration}`);
  });

  next();
}

export function cacheControl(maxAge: number) {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", `private, max-age=${maxAge}`);
    next();
  };
}
