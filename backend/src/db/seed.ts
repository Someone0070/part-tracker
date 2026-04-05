import bcrypt from "bcrypt";
import { getDb } from "./index.js";
import { settings } from "./schema.js";

export async function seedSettings(defaultPassword: string) {
  const db = getDb();
  const [existing] = await db.select().from(settings).limit(1);
  if (existing) return; // Already seeded

  const hash = await bcrypt.hash(defaultPassword, 12);
  await db.insert(settings).values({
    passwordHash: hash,
  });
  console.log("Settings row seeded with default password");
}
