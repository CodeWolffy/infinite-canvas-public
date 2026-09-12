ALTER TABLE channels ADD COLUMN capability text NOT NULL CHECK (capability IN ('image','text','video','audio'));
