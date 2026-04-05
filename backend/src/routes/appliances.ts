import { Router } from "express";
import { getDb } from "../db/index.js";
import { appliances, parts } from "../db/schema.js";
import { eq, desc } from "drizzle-orm";
import { validateBody, createApplianceSchema, updateApplianceSchema, addPartSchema } from "../middleware/validate.js";
import { addPart } from "../services/inventory.js";

const router = Router();

// GET /api/appliances — list all, newest first
router.get("/", async (req, res) => {
  try {
    const db = getDb();
    const results = await db.select().from(appliances).orderBy(desc(appliances.createdAt));
    res.json(results.map(applianceToJson));
  } catch (err) {
    console.error("List appliances error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/appliances/:id — single appliance with linked parts
router.get("/:id", async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt((req.params as Record<string, string>)["id"], 10);

    const [appliance] = await db.select().from(appliances).where(eq(appliances.id, id)).limit(1);
    if (!appliance) {
      res.status(404).json({ error: "Appliance not found" });
      return;
    }

    const linkedParts = await db.select().from(parts).where(eq(parts.applianceId, id));

    res.json({
      appliance: applianceToJson(appliance),
      parts: linkedParts.map(partToJson),
    });
  } catch (err) {
    console.error("Get appliance error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /api/appliances — create appliance
router.post("/", validateBody(createApplianceSchema), async (req, res) => {
  try {
    const db = getDb();
    const [appliance] = await db
      .insert(appliances)
      .values({
        brand: req.body.brand,
        modelNumber: req.body.modelNumber,
        serialNumber: req.body.serialNumber,
        applianceType: req.body.applianceType,
        notes: req.body.notes,
        photoKey: req.body.photoKey,
      })
      .returning();
    res.status(201).json(applianceToJson(appliance));
  } catch (err) {
    console.error("Create appliance error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// PATCH /api/appliances/:id — update appliance
router.patch("/:id", validateBody(updateApplianceSchema), async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt((req.params as Record<string, string>)["id"], 10);

    const [existing] = await db.select().from(appliances).where(eq(appliances.id, id)).limit(1);
    if (!existing) {
      res.status(404).json({ error: "Appliance not found" });
      return;
    }

    const [updated] = await db
      .update(appliances)
      .set({
        ...(req.body.brand !== undefined && { brand: req.body.brand }),
        ...(req.body.modelNumber !== undefined && { modelNumber: req.body.modelNumber }),
        ...(req.body.serialNumber !== undefined && { serialNumber: req.body.serialNumber }),
        ...(req.body.applianceType !== undefined && { applianceType: req.body.applianceType }),
        ...(req.body.notes !== undefined && { notes: req.body.notes }),
        ...(req.body.photoKey !== undefined && { photoKey: req.body.photoKey }),
        ...(req.body.status !== undefined && { status: req.body.status }),
        updatedAt: new Date(),
      })
      .where(eq(appliances.id, id))
      .returning();

    res.json(applianceToJson(updated));
  } catch (err) {
    console.error("Update appliance error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /api/appliances/:id/parts — add a part linked to this appliance
router.post("/:id/parts", validateBody(addPartSchema), async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt((req.params as Record<string, string>)["id"], 10);

    const [appliance] = await db.select().from(appliances).where(eq(appliances.id, id)).limit(1);
    if (!appliance) {
      res.status(404).json({ error: "Appliance not found" });
      return;
    }

    const brandPart = appliance.brand ?? "";
    const modelPart = appliance.modelNumber ?? "";
    const provenance = `Pulled from ${brandPart} ${modelPart} (appliance #${id})`.trim();

    const note = req.body.note ?? provenance;

    const part = await addPart({
      partNumber: req.body.partNumber,
      brand: req.body.brand,
      description: req.body.description,
      quantity: req.body.quantity,
      note,
    });

    await db
      .update(parts)
      .set({ applianceId: id, updatedAt: new Date() })
      .where(eq(parts.id, part.id));

    const [updated] = await db.select().from(parts).where(eq(parts.id, part.id));
    res.status(201).json(partToJson(updated));
  } catch (err) {
    console.error("Add part to appliance error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// --- Helpers ---

function applianceToJson(a: typeof appliances.$inferSelect) {
  return {
    id: a.id,
    brand: a.brand,
    modelNumber: a.modelNumber,
    serialNumber: a.serialNumber,
    applianceType: a.applianceType,
    notes: a.notes,
    photoKey: a.photoKey,
    status: a.status,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

function partToJson(p: typeof parts.$inferSelect) {
  return {
    id: p.id,
    partNumber: p.partNumber,
    partNumberRaw: p.partNumberRaw,
    brand: p.brand,
    description: p.description,
    quantity: p.quantity,
    listedQuantity: p.listedQuantity,
    available: p.quantity - p.listedQuantity,
    ebayListingId: p.ebayListingId,
    applianceId: p.applianceId,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export default router;
