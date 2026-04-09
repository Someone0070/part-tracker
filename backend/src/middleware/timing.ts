import type { Request, Response, NextFunction } from "express";

const SLOW_THRESHOLD_MS = 500;

export function timingMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = performance.now();

  // Set Server-Timing header before response is sent
  const originalEnd = res.end.bind(res);
  res.end = function (this: Response, ...args: Parameters<typeof originalEnd>) {
    const duration = Math.round(performance.now() - start);
    if (!res.headersSent) {
      res.setHeader("Server-Timing", `total;dur=${duration}`);
    }
    if (duration >= SLOW_THRESHOLD_MS) {
      console.warn(`SLOW ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
    }
    return originalEnd(...args);
  } as typeof originalEnd;

  next();
}

export function cacheControl(maxAge: number) {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", `private, max-age=${maxAge}`);
    next();
  };
}
