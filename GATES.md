# Gates: resilient image ingestion

OWNS: GATES.md, README.md, scripts/**, backend/.env.example, backend/package.json, backend/package-lock.json, backend/src/**, backend/drizzle/**, frontend/package.json, frontend/package-lock.json, frontend/src/**

Scope: Make part-label OCR, appliance-label OCR, and optional appliance-photo storage safe for real phone formats and unreliable connections, with actionable errors, retries, progress, retained files, telemetry, and regression coverage.

- [x] G0: this completion ledger has decisive, well-formed acceptance checks
  CHECK: node /Users/alexk/.codex/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/alexk/Documents/AntiGravity/Part-Tracker/.worktrees/backend-core; path=929ae491bca7/18 entries; EXPECT=matched; output-sha256=7b1bdcf4069943c35c16cd0e4711984b38fa5e73cf15280caadefc49205318d0; output-bytes=150

- [x] G1: backend image ingestion validates bytes, normalizes supported phone images, enforces decoded limits, and classifies failures
  CHECK: node scripts/verify-backend-image-pipeline.mjs
  EXPECT: backend image pipeline verified
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/alexk/Documents/AntiGravity/Part-Tracker/.worktrees/backend-core; path=929ae491bca7/18 entries; EXPECT=matched; output-sha256=e01eb6778bb728c10329c0a6d3ecadc66d6a2742db4afcc467deb767db111504; output-bytes=32

- [x] G2: OCR and R2 routes use binary multipart ingestion, bounded provider/storage calls, correct MIME data, and attempt telemetry
  CHECK: node scripts/verify-backend-image-routes.mjs
  EXPECT: backend image routes verified
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/alexk/Documents/AntiGravity/Part-Tracker/.worktrees/backend-core; path=929ae491bca7/18 entries; EXPECT=matched; output-sha256=b4446a6d31594cd81eef216d753c466fe5edc36d5f89a69a05e413bfa438bac6; output-bytes=30

- [x] G3: frontend image preparation and upload transport provide conversion, size reduction, timeout, retry, offline handling, cancellation, and progress
  CHECK: node scripts/verify-frontend-image-pipeline.mjs
  EXPECT: frontend image pipeline verified
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/alexk/Documents/AntiGravity/Part-Tracker/.worktrees/backend-core; path=929ae491bca7/18 entries; EXPECT=matched; output-sha256=b115b66f0f29b66b468da62670de33b894b22249d3e201133031e22449208101; output-bytes=33

- [x] G4: single, bulk, and appliance scan interfaces retain failed files, expose actionable retry, and never silently discard a selected photo
  CHECK: node scripts/verify-image-ui-integration.mjs
  EXPECT: image UI integration verified
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/alexk/Documents/AntiGravity/Part-Tracker/.worktrees/backend-core; path=929ae491bca7/18 entries; EXPECT=matched; output-sha256=89f5b32e778dde4de7e3b1f8b324d52c35d913c83f40fe6db3a6aa5582e74cdc; output-bytes=30

- [x] G5: production builds and the complete backend and frontend test suites pass together
  CHECK: node scripts/verify-image-regressions.mjs
  EXPECT: image regression suite verified
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/alexk/Documents/AntiGravity/Part-Tracker/.worktrees/backend-core; path=929ae491bca7/18 entries; EXPECT=matched; output-sha256=e737ce316ca6389daac92563aab021c730c8d8a82372c1aeff0c665a5cd86bb8; output-bytes=32

- [x] G6: final expert review finds no unresolved correctness, integration, reliability, performance, or observability defect in the changed image paths
  EVIDENCE: Reviewed multipart streaming through the Pages proxy; browser and server byte/dimension limits; signature, MIME, orientation, and conversion handling; bounded and abortable client/OCR/storage retries; stable per-file upload IDs and deterministic R2 keys; retained-file retry UX for single, bulk, sticker, and unit-photo paths; JSON error containment; and privacy-safe indexed attempt telemetry. No image bytes, filenames, credentials, or provider response bodies enter telemetry or public errors. Final full suites passed 198 backend and 14 frontend tests, and both production builds passed.
