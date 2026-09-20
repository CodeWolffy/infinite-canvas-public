-- 真实流量失败独立计数。
ALTER TABLE channels ADD COLUMN consecutive_request_failures integer NOT NULL DEFAULT 0;
