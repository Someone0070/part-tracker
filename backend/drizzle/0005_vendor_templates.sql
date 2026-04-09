CREATE TABLE "vendor_templates" (
  "id" serial PRIMARY KEY NOT NULL,
  "vendor_key" text NOT NULL UNIQUE,
  "vendor_name" text NOT NULL,
  "vendor_domains" text[] NOT NULL DEFAULT '{}'::text[],
  "vendor_keywords" text[] NOT NULL DEFAULT '{}'::text[],
  "extraction_rules" text NOT NULL,
  "success_count" integer NOT NULL DEFAULT 0,
  "fail_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "idx_vendor_templates_domains" ON "vendor_templates" USING GIN ("vendor_domains");
CREATE INDEX "idx_vendor_templates_keywords" ON "vendor_templates" USING GIN ("vendor_keywords");
