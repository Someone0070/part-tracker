import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import { getDb } from "./index.js";
import { settings, vendorCookies } from "./schema.js";

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

export async function seedPresetVendors() {
  const db = getDb();
  const presets = [
    { vendorName: "Amazon", domain: "amazon.com" },
    { vendorName: "eBay", domain: "ebay.com" },
    { vendorName: "Marcone", domain: "marcone.com" },
  ];

  for (const preset of presets) {
    const [existing] = await db
      .select({ id: vendorCookies.id })
      .from(vendorCookies)
      .where(eq(vendorCookies.domain, preset.domain))
      .limit(1);
    if (existing) continue;

    await db.insert(vendorCookies).values({
      vendorName: preset.vendorName,
      domain: preset.domain,
      cookieData: "",
      isPreset: true,
      status: "unconfigured",
    });
  }
  console.log("Preset vendor rows seeded");
}
