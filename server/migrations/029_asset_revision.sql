ALTER TABLE assets ADD COLUMN revision BIGINT;
UPDATE assets SET revision=0 WHERE revision IS NULL;
ALTER TABLE assets ALTER COLUMN revision SET DEFAULT 0;
ALTER TABLE assets ALTER COLUMN revision SET NOT NULL;
ALTER TABLE assets ADD COLUMN client_request_id TEXT;
ALTER TABLE assets ADD COLUMN client_request_hash TEXT;
CREATE UNIQUE INDEX assets_owner_request_id ON assets(owner_id,client_request_id);
