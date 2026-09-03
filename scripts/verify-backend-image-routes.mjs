import { requireText, run } from "./verify-utils.mjs";

run("backend", ["exec", "--", "tsx", "--test", "src/routes/image-handler.test.ts"]);
run("backend", ["run", "build"]);
requireText("backend/src/routes/parts.ts", "receiveImage", "imageHandler(\"part_ocr\"");
requireText("backend/src/routes/appliances.ts", "imageHandler(\"appliance_ocr\"", "imageHandler(\"appliance_photo\"", "image.mime", "appliances/${uploadId}.jpg");
requireText("backend/src/services/ocr.ts", "imageToDataUri(image)", "fetchWithRetry", "timeoutMs: 25_000");
requireText("backend/src/services/r2.ts", "AbortSignal.timeout(25_000)", "StorageUploadError");
requireText("backend/src/routes/image-handler.ts", "recordImageAttempt", "retryable", "providerStatus", "X-Request-Id");
requireText("backend/src/services/image-idempotency.ts", "runImageOperationOnce", "CACHE_TTL_MS", "MAX_CACHE_ENTRIES");
requireText("backend/drizzle/0011_image_upload_attempts.sql", "image_upload_attempts", "error_category", "duration_ms");
requireText("backend/src/routes/settings.ts", "/image-attempts/summary", "breakdown");
process.stdout.write("backend image routes verified\n");
