-- Learned prefixes table: stores junk prefixes learned from nano comparisons
CREATE TABLE "learned_prefixes" (
  "id" serial PRIMARY KEY,
  "prefix" text NOT NULL UNIQUE,
  "source_vendor" text NOT NULL,
  "hit_count" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Seed with known status prefixes (hit_count=3 so they're immediately active)
INSERT INTO "learned_prefixes" ("prefix", "source_vendor", "hit_count") VALUES
  ('SHIPPED', 'seed', 3),
  ('BACKORDERED', 'seed', 3),
  ('BACK ORDERED', 'seed', 3),
  ('IN STOCK', 'seed', 3),
  ('OUT OF STOCK', 'seed', 3),
  ('PENDING', 'seed', 3),
  ('ON ORDER', 'seed', 3),
  ('B/O', 'seed', 3);
