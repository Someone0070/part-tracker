import { requireText, run } from "./verify-utils.mjs";

run("frontend", [
  "exec",
  "--",
  "vitest",
  "run",
  "src/lib/image-upload.test.ts",
  "src/api/client-upload.test.ts",
]);
requireText("frontend/src/lib/image-upload.ts", "createImageBitmap", "imageOrientation: \"from-image\"", "IMAGE_MAX_EDGE", "image/jpeg");
requireText("frontend/src/api/client.ts", "XMLHttpRequest", "FormData", "onProgress", "navigator.onLine", "throwIfAborted", "shouldRetryUpload", "uploadIds", "form.append(\"uploadId\"");
process.stdout.write("frontend image pipeline verified\n");
