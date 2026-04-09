CREATE INDEX IF NOT EXISTS parts_updated_at_idx ON parts (updated_at);
CREATE INDEX IF NOT EXISTS parts_appliance_id_idx ON parts (appliance_id);
CREATE INDEX IF NOT EXISTS appliances_created_at_idx ON appliances (created_at);
CREATE INDEX IF NOT EXISTS cross_references_part_id_idx ON cross_references (part_id);
CREATE INDEX IF NOT EXISTS cross_references_cross_ref_pn_idx ON cross_references (cross_ref_part_number);
CREATE INDEX IF NOT EXISTS inventory_events_part_created_idx ON inventory_events (part_id, created_at);
