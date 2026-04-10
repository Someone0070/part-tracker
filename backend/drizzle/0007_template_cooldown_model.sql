-- Add cooldown tracking for template generation attempts
ALTER TABLE "vendor_templates"
  ADD COLUMN "last_generation_attempt" timestamp with time zone;

-- Add template model selection to settings
ALTER TABLE "settings"
  ADD COLUMN "template_model" text NOT NULL DEFAULT 'glm-4.7-flash';
