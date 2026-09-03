import { requireText, source } from "./verify-utils.mjs";

requireText(
  "frontend/src/pages/AddPartPage.tsx",
  "apiUpload",
  "prepareImageFile",
  "setSelectedFile(uploadFile)",
  "Retry",
  "retryPart",
  "Uploading ${uploadProgress}%",
  "file: File",
);
requireText(
  "frontend/src/pages/NewAppliance.tsx",
  "apiUpload",
  "prepareImageFile",
  "setStickerFile(uploadFile)",
  "photoStorageConfigured",
  "setSubmitting(false);\n        return;",
  "Retry Photo Upload",
  "Uploading ${ocrProgress}%",
);

const legacyPattern = /JSON\.stringify\(\{\s*image:\s*(?:base64|unitPhotoBase64)/;
if (!legacyPattern.test("JSON.stringify({ image: base64 })")) {
  throw new Error("legacy-upload absence check has a broken positive control");
}
for (const path of ["frontend/src/pages/AddPartPage.tsx", "frontend/src/pages/NewAppliance.tsx"]) {
  if (legacyPattern.test(source(path))) throw new Error(`${path} still contains a Base64 JSON image upload`);
}
process.stdout.write("image UI integration verified\n");
