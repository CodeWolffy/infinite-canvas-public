ALTER TABLE channels ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE channels ALTER COLUMN timeout_ms SET DEFAULT 300000;
ALTER TABLE channels ALTER COLUMN max_concurrency SET DEFAULT 20;
