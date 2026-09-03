import { getDb } from "../db/index.js";
import { imageUploadAttempts } from "../db/schema.js";

export type ImageAttemptKind = "part_ocr" | "appliance_ocr" | "appliance_photo";

export interface ImageAttemptRecord {
  requestId: string;
  kind: ImageAttemptKind;
  status: "succeeded" | "failed";
  originalMime?: string | null;
  originalBytes?: number | null;
  normalizedMime?: string | null;
  normalizedBytes?: number | null;
  errorCategory?: string | null;
  providerStatus?: number | null;
  durationMs: number;
}

export async function recordImageAttempt(record: ImageAttemptRecord): Promise<void> {
  try {
    await getDb().insert(imageUploadAttempts).values(record);
  } catch (error) {
    // Telemetry must never make an otherwise-valid scan fail. Keep this structured
    // and free of image bytes, filenames, provider bodies, or credentials.
    console.warn(JSON.stringify({
      event: "image_attempt_telemetry_failed",
      requestId: record.requestId,
      kind: record.kind,
      message: error instanceof Error ? error.message : "unknown database error",
    }));
  }
}
