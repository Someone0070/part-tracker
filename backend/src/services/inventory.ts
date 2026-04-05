import { getDb } from "../db/index.js";
import { parts, inventoryEvents } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import { normalizePartNumber } from "./normalize.js";

interface AddPartInput {
  partNumber: string;
  brand?: string;
  description?: string;
  quantity: number;
  note?: string;
}

interface DepletePartInput {
  partId: number;
  quantity: number;
  reason: "used" | "sold";
  note?: string;
}

export async function addPart(input: AddPartInput) {
  const db = getDb();
  const normalized = normalizePartNumber(input.partNumber);

  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(parts)
      .where(eq(parts.partNumber, normalized))
      .for("update");

    let partId: number;

    if (existing) {
      await tx
        .update(parts)
        .set({
          quantity: sql`${parts.quantity} + ${input.quantity}`,
          ...(input.brand !== undefined && { brand: input.brand }),
          ...(input.description !== undefined && { description: input.description }),
          updatedAt: new Date(),
        })
        .where(eq(parts.id, existing.id));
      partId = existing.id;
    } else {
      const [newPart] = await tx
        .insert(parts)
        .values({
          partNumber: normalized,
          partNumberRaw: input.partNumber.trim().replace(/^#+/, ""),
          brand: input.brand,
          description: input.description,
          quantity: input.quantity,
        })
        .returning({ id: parts.id });
      partId = newPart.id;
    }

    await tx.insert(inventoryEvents).values({
      partId,
      eventType: "added",
      quantityChange: input.quantity,
      note: input.note,
    });

    const [result] = await tx.select().from(parts).where(eq(parts.id, partId));
    return result;
  });
}

export async function depletePart(input: DepletePartInput) {
  const db = getDb();

  return await db.transaction(async (tx) => {
    const [part] = await tx
      .select()
      .from(parts)
      .where(eq(parts.id, input.partId))
      .for("update");

    if (!part) {
      throw new Error("Part not found");
    }

    const available = part.quantity - part.listedQuantity;
    if (input.quantity > available) {
      throw new Error(`Cannot deplete ${input.quantity} — only ${available} available (${part.listedQuantity} listed on eBay)`);
    }

    await tx
      .update(parts)
      .set({
        quantity: sql`${parts.quantity} - ${input.quantity}`,
        updatedAt: new Date(),
      })
      .where(eq(parts.id, part.id));

    await tx.insert(inventoryEvents).values({
      partId: part.id,
      eventType: input.reason,
      quantityChange: -input.quantity,
      note: input.note,
    });

    const [result] = await tx.select().from(parts).where(eq(parts.id, part.id));
    return result;
  });
}

export async function updatePartMetadata(partId: number, data: {
  brand?: string;
  description?: string;
  ebayListingId?: string | null;
  listedQuantity?: number;
}) {
  const db = getDb();

  return await db.transaction(async (tx) => {
    const [part] = await tx
      .select()
      .from(parts)
      .where(eq(parts.id, partId))
      .for("update");

    if (!part) {
      throw new Error("Part not found");
    }

    const newListedQty = data.listedQuantity ?? part.listedQuantity;
    const newEbayId = data.ebayListingId !== undefined ? data.ebayListingId : part.ebayListingId;

    if (newListedQty < 0 || newListedQty > part.quantity) {
      throw new Error(`listed_quantity must be between 0 and ${part.quantity}`);
    }
    if (newListedQty > 0 && !newEbayId) {
      throw new Error("ebay_listing_id required when listed_quantity > 0");
    }
    if (newListedQty === 0 && newEbayId) {
      throw new Error("ebay_listing_id must be null when listed_quantity is 0");
    }

    await tx
      .update(parts)
      .set({
        ...(data.brand !== undefined && { brand: data.brand }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.ebayListingId !== undefined && { ebayListingId: data.ebayListingId }),
        ...(data.listedQuantity !== undefined && { listedQuantity: data.listedQuantity }),
        updatedAt: new Date(),
      })
      .where(eq(parts.id, partId));

    const [result] = await tx.select().from(parts).where(eq(parts.id, partId));
    return result;
  });
}
