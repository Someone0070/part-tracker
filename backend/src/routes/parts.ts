import { Router } from "express";
import { getDb } from "../db/index.js";
import { parts, crossReferences, inventoryEvents } from "../db/schema.js";
import { eq, ilike, sql, desc, or, and, gt } from "drizzle-orm";
import { validateBody, addPartSchema, depletePartSchema, updatePartSchema } from "../middleware/validate.js";
import { addPart, depletePart, updatePartMetadata } from "../services/inventory.js";
import { normalizePartNumber } from "../services/normalize.js";

const router = Router();

// GET /api/parts — list all, optional search
router.get("/", async (req, res) => {
  try {
    const db = getDb();
    const search = typeof req.query.search === "string" ? req.query.search : undefined;

    let query = db.select().from(parts);
    if (search) {
      const normalized = normalizePartNumber(search);
      query = query.where(ilike(parts.partNumber, `%${normalized}%`)) as typeof query;
    }

    const results = await query.orderBy(desc(parts.updatedAt));
    res.json(results.map(partToJson));
  } catch (err) {
    console.error("List parts error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/parts/lookup — main lookup endpoint
router.get("/lookup", async (req, res) => {
  try {
    const partNumber = typeof req.query.partNumber === "string" ? req.query.partNumber : "";
    if (!partNumber) {
      res.status(400).json({ error: "partNumber query param required" });
      return;
    }

    const db = getDb();
    const normalized = normalizePartNumber(partNumber);

    // Find exact match
    const [exactMatch] = await db
      .select()
      .from(parts)
      .where(eq(parts.partNumber, normalized))
      .limit(1);

    // Find alternatives via cross-references (both directions)
    const alternatives = await findAlternatives(db, normalized);

    res.json({
      exact: exactMatch ? partToJson(exactMatch) : null,
      alternatives,
    });
  } catch (err) {
    console.error("Lookup error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/parts/:id — single part with cross-refs and events
router.get("/:id(\\d+)", async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt((req.params as Record<string, string>)["id"], 10);

    const [part] = await db.select().from(parts).where(eq(parts.id, id)).limit(1);
    if (!part) {
      res.status(404).json({ error: "Part not found" });
      return;
    }

    // Get cross-references
    const crossRefs = await db
      .select()
      .from(crossReferences)
      .where(eq(crossReferences.partId, part.id));

    // Check which cross-ref parts are in stock
    const crossRefsWithStock = await Promise.all(
      crossRefs.map(async (ref) => {
        const normalized = normalizePartNumber(ref.crossRefPartNumber);
        const [stockPart] = await db
          .select({ quantity: parts.quantity })
          .from(parts)
          .where(eq(parts.partNumber, normalized))
          .limit(1);
        return {
          crossRefPartNumber: ref.crossRefPartNumber,
          relationship: ref.relationship,
          inStock: !!stockPart && stockPart.quantity > 0,
          quantity: stockPart?.quantity ?? 0,
        };
      })
    );

    // Get events (paginated)
    const limit = parseInt(String(req.query.eventsLimit)) || 20;
    const offset = parseInt(String(req.query.eventsOffset)) || 0;

    const events = await db
      .select()
      .from(inventoryEvents)
      .where(eq(inventoryEvents.partId, id))
      .orderBy(desc(inventoryEvents.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({
      part: partToJson(part),
      crossReferences: crossRefsWithStock,
      events: events.map(eventToJson),
    });
  } catch (err) {
    console.error("Get part error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /api/parts — add/upsert
router.post("/", validateBody(addPartSchema), async (req, res) => {
  try {
    const result = await addPart(req.body);
    res.status(201).json(partToJson(result));
  } catch (err) {
    console.error("Add part error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// PATCH /api/parts/:id — update metadata only
router.patch("/:id(\\d+)", validateBody(updatePartSchema), async (req, res) => {
  try {
    const id = parseInt((req.params as Record<string, string>)["id"], 10);
    const result = await updatePartMetadata(id, req.body);
    res.json(partToJson(result));
  } catch (err: any) {
    if (err.message?.includes("not found")) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err.message?.includes("must be") || err.message?.includes("required")) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Update part error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /api/parts/:id/deplete
router.post("/:id(\\d+)/deplete", validateBody(depletePartSchema), async (req, res) => {
  try {
    const id = parseInt((req.params as Record<string, string>)["id"], 10);
    const result = await depletePart({
      partId: id,
      quantity: req.body.quantity,
      reason: req.body.reason,
    });
    res.json(partToJson(result));
  } catch (err: any) {
    if (err.message?.includes("not found")) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err.message?.includes("Cannot deplete")) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Deplete part error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// --- Helpers ---

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
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function eventToJson(e: typeof inventoryEvents.$inferSelect) {
  return {
    id: e.id,
    eventType: e.eventType,
    quantityChange: e.quantityChange,
    note: e.note,
    createdAt: e.createdAt.toISOString(),
  };
}

async function findAlternatives(db: ReturnType<typeof getDb>, normalizedPartNumber: string) {
  const [part] = await db
    .select({ id: parts.id })
    .from(parts)
    .where(eq(parts.partNumber, normalizedPartNumber))
    .limit(1);

  if (!part) return [];

  // Forward: parts this one references
  const forward = await db
    .select({ crossRefPartNumber: crossReferences.crossRefPartNumber, relationship: crossReferences.relationship })
    .from(crossReferences)
    .where(eq(crossReferences.partId, part.id));

  // Reverse: parts that reference this one
  const reverse = await db
    .select({ partId: crossReferences.partId, relationship: crossReferences.relationship })
    .from(crossReferences)
    .where(eq(crossReferences.crossRefPartNumber, normalizedPartNumber));

  // Deduplicate by normalized part number
  const seen = new Set<string>([normalizedPartNumber]);
  const alternatives: Array<{ partNumber: string; relationship: string; quantity: number; available: number }> = [];

  for (const ref of forward) {
    const norm = normalizePartNumber(ref.crossRefPartNumber);
    if (seen.has(norm)) continue;
    seen.add(norm);

    const [stockPart] = await db.select().from(parts).where(eq(parts.partNumber, norm)).limit(1);
    if (stockPart && stockPart.quantity > 0) {
      alternatives.push({
        partNumber: stockPart.partNumber,
        relationship: ref.relationship,
        quantity: stockPart.quantity,
        available: stockPart.quantity - stockPart.listedQuantity,
      });
    }
  }

  for (const ref of reverse) {
    const [refPart] = await db.select().from(parts).where(eq(parts.id, ref.partId)).limit(1);
    if (!refPart) continue;
    if (seen.has(refPart.partNumber)) continue;
    seen.add(refPart.partNumber);

    if (refPart.quantity > 0) {
      alternatives.push({
        partNumber: refPart.partNumber,
        relationship: ref.relationship,
        quantity: refPart.quantity,
        available: refPart.quantity - refPart.listedQuantity,
      });
    }
  }

  return alternatives;
}

export default router;
