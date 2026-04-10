import { getDb } from "../db/index.js";
import { settings, ebayProcessedOrders } from "../db/schema.js";
import { isNotNull, sql } from "drizzle-orm";

export interface AppSettingsSummary {
  crossRefEnabled: boolean;
  darkMode: boolean;
  extractionModel: string;
  templateModel: string;
  ebay: {
    enabled: boolean;
    connected: boolean;
    quarantinedCount: number;
  };
  apiKey: {
    exists: boolean;
    prefix: string | null;
    scopes: string[];
  };
}

interface SettingsSnapshot extends AppSettingsSummary {
  passwordVersion: number;
}

const SETTINGS_SUMMARY_TTL = 30_000;

let settingsSummaryCache:
  | {
      value: SettingsSnapshot;
      fetchedAt: number;
    }
  | null = null;

export async function getCachedSettingsSnapshot(): Promise<SettingsSnapshot | null> {
  if (
    settingsSummaryCache &&
    Date.now() - settingsSummaryCache.fetchedAt < SETTINGS_SUMMARY_TTL
  ) {
    return settingsSummaryCache.value;
  }

  const db = getDb();
  const [row] = await db.select().from(settings).limit(1);
  if (!row) return null;

  const [quarantine] = await db
    .select({ count: sql<number>`count(*)` })
    .from(ebayProcessedOrders)
    .where(isNotNull(ebayProcessedOrders.quarantineReason));

  let scopes: string[] = [];
  try {
    scopes = row.apiKeyScopes ? JSON.parse(row.apiKeyScopes) : [];
  } catch {
    scopes = [];
  }

  const snapshot: SettingsSnapshot = {
    crossRefEnabled: row.crossRefEnabled,
    darkMode: row.darkMode,
    extractionModel: row.extractionModel,
    templateModel: row.templateModel,
    ebay: {
      enabled: row.ebayEnabled,
      connected: !!row.ebayRefreshToken,
      quarantinedCount: Number(quarantine.count),
    },
    apiKey: {
      exists: !!row.apiKeyHash,
      prefix: row.apiKeyPrefix || null,
      scopes,
    },
    passwordVersion: row.passwordVersion,
  };

  settingsSummaryCache = {
    value: snapshot,
    fetchedAt: Date.now(),
  };

  return snapshot;
}

export function toPublicSettingsSummary(
  snapshot: SettingsSnapshot
): AppSettingsSummary {
  const { passwordVersion: _passwordVersion, ...publicSummary } = snapshot;
  return publicSummary;
}

export function invalidateSettingsSummaryCache() {
  settingsSummaryCache = null;
}
