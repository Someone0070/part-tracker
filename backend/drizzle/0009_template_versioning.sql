-- Step 1: Drop old unique constraint on vendor_key
ALTER TABLE "vendor_templates" DROP CONSTRAINT "vendor_templates_vendor_key_unique";

-- Step 2: Add new columns for versioning
ALTER TABLE "vendor_templates"
  ADD COLUMN "version" integer NOT NULL DEFAULT 1,
  ADD COLUMN "recent_results" jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN "status" text NOT NULL DEFAULT 'active';

-- Step 3: Add new unique constraint on (vendor_key, version)
ALTER TABLE "vendor_templates"
  ADD CONSTRAINT "vendor_templates_vendor_key_version_unique"
  UNIQUE ("vendor_key", "version");

-- Step 4: Index for loading active templates per vendor
CREATE INDEX "idx_vendor_templates_status" ON "vendor_templates" ("vendor_key", "status", "version" DESC);
