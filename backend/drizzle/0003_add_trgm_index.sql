CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS parts_part_number_trgm_idx ON parts USING gin (part_number gin_trgm_ops);
