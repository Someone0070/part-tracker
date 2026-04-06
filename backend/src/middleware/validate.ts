import { z } from "zod";
import type { Request, Response, NextFunction } from "express";

export const addPartSchema = z.object({
  partNumber: z.string().min(1).max(50),
  brand: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  quantity: z.number().int().min(1).default(1),
  note: z.string().max(1000).optional(),
});

export const depletePartSchema = z.object({
  quantity: z.number().int().min(1),
  reason: z.enum(["used", "sold"]),
});

export const updatePartSchema = z.object({
  brand: z.string().max(100).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  ebayListingId: z.string().optional().nullable(),
  listedQuantity: z.number().int().min(0).optional(),
});

export const updateSettingsSchema = z.object({
  crossRefEnabled: z.boolean().optional(),
  darkMode: z.boolean().optional(),
  ebayEnabled: z.boolean().optional(),
});

export const loginSchema = z.object({
  password: z.string().min(1).max(72),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(72),
  newPassword: z.string().min(1).max(72),
});

export const createApplianceSchema = z.object({
  brand: z.string().max(100).optional(),
  modelNumber: z.string().max(100).optional(),
  serialNumber: z.string().max(100).optional(),
  applianceType: z.string().max(100).optional(),
  notes: z.string().max(1000).optional(),
  photoKey: z.string().max(500).optional(),
});

export const updateApplianceSchema = z.object({
  brand: z.string().max(100).optional(),
  modelNumber: z.string().max(100).optional(),
  serialNumber: z.string().max(100).optional(),
  applianceType: z.string().max(100).optional(),
  notes: z.string().max(1000).optional(),
  photoKey: z.string().max(500).optional(),
  status: z.enum(["active", "stripped"]).optional(),
});

export function validateBody<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: "Validation failed", details: result.error.flatten().fieldErrors });
      return;
    }
    req.body = result.data;
    next();
  };
}
