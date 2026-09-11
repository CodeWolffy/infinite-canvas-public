ALTER TABLE user_groups
    ADD COLUMN storage_quota_bytes bigint NOT NULL DEFAULT 0 CHECK (storage_quota_bytes >= 0);
