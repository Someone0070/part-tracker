import type { Request } from "express";

export function getClientIp(req: Request): string {
  const cfIp = req.headers["cf-connecting-ip"];
  if (typeof cfIp === "string") return cfIp;
  return req.ip || "unknown";
}
