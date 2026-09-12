ALTER TABLE upstream_cost_entries ADD COLUMN deadline timestamptz;
CREATE INDEX upstream_cost_probe_deadline_idx ON upstream_cost_entries(deadline) WHERE task_id IS NULL AND status='running';
