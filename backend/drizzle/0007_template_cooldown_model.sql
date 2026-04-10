-- Add cooldown tracking for template generation attempts
ALTER TABLE "vendor_templates"
  ADD COLUMN "last_generation_attempt" timestamp with time zone;

-- Add model selection to settings
ALTER TABLE "settings"
  ADD COLUMN "extraction_model" text NOT NULL DEFAULT 'qwen/qwen3.5-flash-02-23',
  ADD COLUMN "template_model" text NOT NULL DEFAULT 'qwen/qwen3.5-flash-02-23';
