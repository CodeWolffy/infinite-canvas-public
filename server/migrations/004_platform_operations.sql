-- 每个用户可兑换不同的码，同一码仍由联合主键保证仅兑换一次。
ALTER TABLE redeem_uses DROP CONSTRAINT redeem_uses_user_id_key;

ALTER TABLE user_groups
    ADD COLUMN model_ids uuid[],
    ADD COLUMN grant_amount_micros bigint NOT NULL DEFAULT 0 CHECK (grant_amount_micros >= 0),
    ADD COLUMN grant_period text NOT NULL DEFAULT 'month' CHECK (grant_period IN ('day','week','month'));
CREATE TABLE group_grant_claims (
    user_id uuid NOT NULL REFERENCES users(id), period text NOT NULL, period_start date NOT NULL,
    group_id uuid NOT NULL REFERENCES user_groups(id), amount_micros bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,period,period_start)
);

ALTER TABLE model_channels ADD COLUMN cost_config jsonb NOT NULL DEFAULT '{}';
ALTER TABLE generation_tasks
    ADD COLUMN calculated_micros bigint,
    ADD COLUMN partial_text text NOT NULL DEFAULT '',
    ADD COLUMN stream_sequence bigint NOT NULL DEFAULT 0,
    ADD COLUMN first_token_at timestamptz;
ALTER TABLE generation_tasks ALTER COLUMN seconds TYPE numeric;
ALTER TABLE request_logs
    ADD COLUMN first_token_ms integer,
    ADD COLUMN output_tokens bigint;

-- 渠道成本账独立于可清理的请求日志，未知成本不记为零。
CREATE TABLE upstream_cost_entries (
    id uuid PRIMARY KEY, task_id uuid REFERENCES generation_tasks(id), user_id uuid REFERENCES users(id),
    model_id uuid REFERENCES models(id), channel_id uuid NOT NULL REFERENCES channels(id),
    capability text NOT NULL, amount_micros bigint CHECK (amount_micros>=0),
    source text NOT NULL DEFAULT 'unknown' CHECK (source IN ('unknown','configured','actual')),
    status text NOT NULL DEFAULT 'running', cost_config jsonb NOT NULL DEFAULT '{}', note text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX upstream_cost_time_idx ON upstream_cost_entries(created_at DESC);

ALTER TABLE users
    ADD COLUMN email text UNIQUE,
    ADD COLUMN email_verified_at timestamptz,
    ADD COLUMN encrypted_totp_secret text,
    ADD COLUMN encrypted_totp_pending text,
    ADD COLUMN totp_pending_at timestamptz,
    ADD COLUMN totp_last_step bigint NOT NULL DEFAULT -1,
    ADD COLUMN mfa_recovery_hash text;
ALTER TABLE sessions ADD COLUMN ip text NOT NULL DEFAULT '', ADD COLUMN user_agent text NOT NULL DEFAULT '';
CREATE TABLE auth_tokens (
    token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
    purpose text NOT NULL CHECK (purpose IN ('email','password','mfa')),
    value text NOT NULL DEFAULT '', password_hash text NOT NULL,
    expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens(user_id,purpose);

CREATE TABLE notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id),
    event_key text UNIQUE, kind text NOT NULL, title text NOT NULL, content text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_reads (
    notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id), PRIMARY KEY(notification_id,user_id)
);
CREATE TABLE mail_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), encrypted_message text NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
    created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, deadline timestamptz
);
CREATE INDEX mail_queue_idx ON mail_outbox(created_at) WHERE status='queued';

ALTER TABLE channels
    ADD COLUMN monitoring jsonb NOT NULL DEFAULT '{}',
    ADD COLUMN next_check_at timestamptz,
    ADD COLUMN monitor_token uuid,
    ADD COLUMN monitor_deadline timestamptz,
    ADD COLUMN monitor_status text,
    ADD COLUMN monitor_error text,
    ADD COLUMN monitor_checked_at timestamptz,
    ADD COLUMN upstream_models text[],
    ADD COLUMN model_changes jsonb,
    ADD COLUMN upstream_balance text,
    ADD COLUMN balance_status text;
CREATE TABLE channel_checks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel_id uuid NOT NULL REFERENCES channels(id),
    status text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', duration_ms bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
