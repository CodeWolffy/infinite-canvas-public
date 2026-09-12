-- 将每条凭据独立保存；已有渠道密钥原样保留加密内容。
CREATE TABLE channel_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel_id uuid NOT NULL REFERENCES channels(id),
    encrypted_api_key text NOT NULL, key_hint text NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    disabled_reason text, last_used_at timestamptz, last_failure_at timestamptz,
    last_success_at timestamptz, last_error_code text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_keys_rotation_idx ON channel_keys(channel_id,status,last_used_at);
INSERT INTO channel_keys(channel_id,encrypted_api_key,key_hint)
SELECT id,encrypted_api_key,'已配置' FROM channels WHERE coalesce(encrypted_api_key,'')<>'';
ALTER TABLE channels DROP COLUMN encrypted_api_key, DROP COLUMN api_key_hint;
ALTER TABLE channels DROP CONSTRAINT channels_protocol_check;
ALTER TABLE channels ADD CONSTRAINT channels_protocol_check CHECK (protocol IN ('openai','gemini','anthropic'));
ALTER TABLE channels
    ADD COLUMN key_strategy text NOT NULL DEFAULT 'round_robin' CHECK (key_strategy IN ('round_robin','random')),
    ADD COLUMN task_adapter text NOT NULL DEFAULT '',
    ADD COLUMN consecutive_check_failures integer NOT NULL DEFAULT 0,
    ADD COLUMN auto_disabled_at timestamptz;

ALTER TABLE generation_tasks
	ADD COLUMN slot_token uuid,
	ADD COLUMN upstream_completed boolean NOT NULL DEFAULT false,
    ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
    ADD COLUMN max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts>0),
    ADD COLUMN attempted_key_ids uuid[] NOT NULL DEFAULT '{}',
    ADD COLUMN failed_channel_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE request_logs ADD COLUMN key_id uuid REFERENCES channel_keys(id) ON DELETE SET NULL;
ALTER TABLE upstream_cost_entries
    ADD COLUMN key_id uuid REFERENCES channel_keys(id) ON DELETE SET NULL,
    ADD COLUMN binding_id uuid REFERENCES model_channels(id) ON DELETE SET NULL,
    ADD COLUMN duration_ms bigint;

CREATE TABLE channel_binding_checks (
    binding_id uuid PRIMARY KEY REFERENCES model_channels(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('healthy','failed')),
    error_category text,
    duration_ms bigint NOT NULL, checked_at timestamptz NOT NULL
);
