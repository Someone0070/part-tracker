import { run } from "./verify-utils.mjs";

run("backend", [
  "exec",
  "--",
  "tsx",
  "--test",
  "src/services/image-input.test.ts",
  "src/services/http-retry.test.ts",
  "src/services/ocr-image.test.ts",
]);
process.stdout.write("backend image pipeline verified\n");
