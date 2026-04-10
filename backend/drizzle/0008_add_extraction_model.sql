-- Add extraction model column (0007 already ran with only template_model)
ALTER TABLE "settings"
  ADD COLUMN "extraction_model" text NOT NULL DEFAULT 'qwen/qwen3.5-flash-02-23';
