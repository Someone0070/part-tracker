import { Router } from "express";
import { getDb } from "../db/index.js";
import { parts, crossReferences, inventoryEvents } from "../db/schema.js";
import { eq, ilike, sql, desc, or, and, gt, inArray } from "drizzle-orm";
import { validateBody, addPartSchema, depletePartSchema, updatePartSchema } from "../middleware/validate.js";
import { addPart, depletePart, updatePartMetadata } from "../services/inventory.js";
import { normalizePartNumber } from "../services/normalize.js";
import { requireScope } from "../middleware/auth.js";
import { lookupCrossReferences } from "../services/cross-ref.js";
import { extractPartInfo } from "../services/ocr.js";
import { parseDocument } from "../services/document-parser.js";

const router = Router();

// POST /api/parts/ocr — extract part number from photo
// MUST be before /:id routes
router.post("/ocr", requireScope("parts:write"), async (req, res) => {
  const { image } = req.body as { image?: unknown };

  if (typeof image !== "string") {
    res.status(400).json({ error: "image must be a base64 string" });
    return;
  }

  if (image.length > 10 * 1024 * 1024) {
    res.status(400).json({ error: "image exceeds 10MB limit" });
    return;
  }

  try {
    const result = await extractPartInfo(image);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "not configured") {
      res.status(503).json({ error: "OCR service not configured" });
      return;
    }
    console.error("Part OCR error:", err);
    res.status(500).json({ error: "OCR failed" });
  }
});

// POST /api/parts/import -- extract parts from PDF document (SSE stream)
router.post("/import", requireScope("parts:write"), async (req, res) => {
  const { document } = req.body as { document?: unknown };

  if (typeof document !== "string") {
    res.status(400).json({ error: "document must be a base64 string" });
    return;
  }

  if (document.length > 12 * 1024 * 1024) {
    res.status(400).json({ error: "document exceeds 12MB limit" });
    return;
  }

  // Switch to SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Abort on client disconnect to avoid wasted LLM calls
  const abort = new AbortController();
  req.on("close", () => abort.abort());

  const steps: Array<{ step: string; message: string }> = [];

  function sendStep(step: string, message: string) {
    if (abort.signal.aborted) return;
    steps.push({ step, message });
    res.write(`event: step\ndata: ${JSON.stringify({ step, message })}\n\n`);
  }

  try {
    const result = await parseDocument(document, sendStep, abort.signal);
    if (!abort.signal.aborted) {
      res.write(`event: result\ndata: ${JSON.stringify({ ...result, steps })}\n\n`);
    }
    res.end();
  } catch (err) {
    if (!abort.signal.aborted) {
      const message = err instanceof Error ? err.message : "Failed to parse document";
      res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
    }
    res.end();
  }
});

// GET /api/parts — list with optional search, server-side pagination & sorting
router.get("/", requireScope("parts:read"), async (req, res) => {
  try {
    const db = getDb();
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const limit = Math.min(parseInt(String(req.query.limit)) || 50, 500);
    const offset = parseInt(String(req.query.offset)) || 0;

    let query = db.select().from(parts);
    if (search) {
      const normalized = normalizePartNumber(search);
      // Use trigram similarity (pg_trgm GIN index) for substring search
      query = query.where(
        sql`${parts.partNumber} % ${normalized} OR ${parts.partNumber} ILIKE ${'%' + normalized + '%'}`
      ) as typeof query;
    }

    // Sort: out-of-stock to bottom, then by most recently updated
    const results = await query
      .orderBy(sql`CASE WHEN ${parts.quantity} = 0 THEN 1 ELSE 0 END`, desc(parts.updatedAt))
      .limit(limit)
      .offset(offset);
    res.json(results.map(partToJson));
  } catch (err) {
    console.error("List parts error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/parts/lookup — main lookup endpoint
router.get("/lookup", requireScope("parts:read"), async (req, res) => {
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
      found: !!exactMatch,
      part: exactMatch ? partToJson(exactMatch) : null,
      alternatives,
    });
  } catch (err) {
    console.error("Lookup error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/parts/:id — single part with cross-refs and events
router.get("/:id", requireScope("parts:read"), async (req, res) => {
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

    // Batch lookup cross-ref stock levels
    const normalizedRefs = crossRefs.map((r) => normalizePartNumber(r.crossRefPartNumber));
    const uniqueNormalized = [...new Set(normalizedRefs)].filter(Boolean);
    const stockMap = new Map<string, number>();
    if (uniqueNormalized.length > 0) {
      const stockParts = await db
        .select({ partNumber: parts.partNumber, quantity: parts.quantity })
        .from(parts)
        .where(inArray(parts.partNumber, uniqueNormalized));
      for (const sp of stockParts) {
        stockMap.set(sp.partNumber, sp.quantity);
      }
    }
    const crossRefsWithStock = crossRefs.map((ref) => {
      const norm = normalizePartNumber(ref.crossRefPartNumber);
      const qty = stockMap.get(norm) ?? 0;
      return {
        crossRefPartNumber: ref.crossRefPartNumber,
        relationship: ref.relationship,
        inStock: qty > 0,
        quantity: qty,
      };
    });

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

// GET /api/parts/:id/events — paginated events only
router.get("/:id/events", requireScope("parts:read"), async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt((req.params as Record<string, string>)["id"], 10);
    const limit = parseInt(String(req.query.limit)) || 20;
    const offset = parseInt(String(req.query.offset)) || 0;

    const events = await db
      .select()
      .from(inventoryEvents)
      .where(eq(inventoryEvents.partId, id))
      .orderBy(desc(inventoryEvents.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({ events: events.map(eventToJson) });
  } catch (err) {
    console.error("Get events error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /api/parts — add/upsert
router.post("/", requireScope("parts:write"), validateBody(addPartSchema), async (req, res) => {
  try {
    const result = await addPart(req.body);
    res.status(201).json(partToJson(result));
    // Fire-and-forget: cross-reference lookup
    lookupCrossReferences(result.id, result.partNumber, result.brand).catch((err) => {
      console.error("Cross-ref lookup failed:", err);
    });
  } catch (err) {
    console.error("Add part error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// PATCH /api/parts/:id — update metadata only
router.patch("/:id", requireScope("parts:write"), validateBody(updatePartSchema), async (req, res) => {
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
router.post("/:id/deplete", requireScope("parts:write"), validateBody(depletePartSchema), async (req, res) => {
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

// DELETE /api/parts/:id
router.delete("/:id", requireScope("parts:write"), async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt((req.params as Record<string, string>)["id"], 10);

    const [part] = await db.select().from(parts).where(eq(parts.id, id)).limit(1);
    if (!part) {
      res.status(404).json({ error: "Part not found" });
      return;
    }

    // Delete related records first
    await db.delete(inventoryEvents).where(eq(inventoryEvents.partId, id));
    await db.delete(crossReferences).where(eq(crossReferences.partId, id));
    await db.delete(parts).where(eq(parts.id, id));

    res.json({ ok: true });
  } catch (err) {
    console.error("Delete part error:", err);
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
    applianceId: p.applianceId,
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

  // Batch forward lookups
  const forwardNorms = forward
    .map((r) => normalizePartNumber(r.crossRefPartNumber))
    .filter((n) => !seen.has(n));
  for (const n of forwardNorms) seen.add(n);

  if (forwardNorms.length > 0) {
    const stockParts = await db
      .select()
      .from(parts)
      .where(inArray(parts.partNumber, [...new Set(forwardNorms)]));
    const stockByNumber = new Map(stockParts.map((p) => [p.partNumber, p]));
    for (const ref of forward) {
      const norm = normalizePartNumber(ref.crossRefPartNumber);
      const stockPart = stockByNumber.get(norm);
      if (stockPart && stockPart.quantity > 0) {
        alternatives.push({
          partNumber: stockPart.partNumber,
          relationship: ref.relationship,
          quantity: stockPart.quantity,
          available: stockPart.quantity - stockPart.listedQuantity,
        });
      }
    }
  }

  // Batch reverse lookups
  const reverseIds = reverse.map((r) => r.partId);
  if (reverseIds.length > 0) {
    const refParts = await db
      .select()
      .from(parts)
      .where(inArray(parts.id, reverseIds));
    const partsById = new Map(refParts.map((p) => [p.id, p]));
    for (const ref of reverse) {
      const refPart = partsById.get(ref.partId);
      if (!refPart || seen.has(refPart.partNumber)) continue;
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
  }

  return alternatives;
}

export default router;
