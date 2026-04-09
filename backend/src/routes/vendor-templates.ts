import { Router } from "express";
import { getDb } from "../db/index.js";
import { vendorTemplates } from "../db/schema.js";
import { eq } from "drizzle-orm";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const db = getDb();
    const rows = await db
      .select({
        id: vendorTemplates.id,
        vendorKey: vendorTemplates.vendorKey,
        vendorName: vendorTemplates.vendorName,
        successCount: vendorTemplates.successCount,
        failCount: vendorTemplates.failCount,
        createdAt: vendorTemplates.createdAt,
        updatedAt: vendorTemplates.updatedAt,
      })
      .from(vendorTemplates)
      .orderBy(vendorTemplates.vendorName);

    res.json(rows);
  } catch (err) {
    console.error("List templates error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid template ID" });
      return;
    }

    const db = getDb();
    const deleted = await db
      .delete(vendorTemplates)
      .where(eq(vendorTemplates.id, id))
      .returning({ id: vendorTemplates.id });

    if (deleted.length === 0) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Delete template error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
