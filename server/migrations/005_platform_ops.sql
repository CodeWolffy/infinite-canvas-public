ALTER TABLE user_groups
    ADD COLUMN spend_limit_micros bigint NOT NULL DEFAULT 0 CHECK (spend_limit_micros >= 0),
    ADD COLUMN spend_period text NOT NULL DEFAULT 'month' CHECK (spend_period IN ('day','week','month'));

CREATE INDEX notifications_created_idx ON notifications(created_at);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE INDEX channel_checks_created_idx ON channel_checks(channel_id, created_at DESC);
CREATE INDEX channel_checks_time_idx ON channel_checks(created_at);
