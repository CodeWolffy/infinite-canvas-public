CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username varchar(64) NOT NULL UNIQUE,
    password_hash text NOT NULL, display_name varchar(80) NOT NULL,
    role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    must_change_password boolean NOT NULL DEFAULT false, last_login_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
    token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE invitations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code_hash text NOT NULL UNIQUE, code_hint text NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id), note text NOT NULL DEFAULT '',
    max_uses integer NOT NULL CHECK (max_uses > 0), used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
    expires_at timestamptz, disabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invitation_uses (
    invitation_id uuid NOT NULL REFERENCES invitations(id), user_id uuid NOT NULL UNIQUE REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(invitation_id,user_id)
);
CREATE TABLE user_preferences (user_id uuid PRIMARY KEY REFERENCES users(id), preferences jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app_settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE wallets (
    user_id uuid PRIMARY KEY REFERENCES users(id), balance_micros bigint NOT NULL DEFAULT 0 CHECK (balance_micros >= 0),
    frozen_micros bigint NOT NULL DEFAULT 0 CHECK (frozen_micros >= 0), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE wallet_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), kind text NOT NULL,
    reference text NOT NULL, delta_balance bigint NOT NULL, delta_frozen bigint NOT NULL,
    balance_after bigint NOT NULL, frozen_after bigint NOT NULL, note text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,kind,reference)
);
CREATE INDEX wallet_entries_user_idx ON wallet_entries(user_id,created_at DESC,id);
CREATE TABLE checkins (
    user_id uuid NOT NULL REFERENCES users(id), day date NOT NULL, reward_micros bigint NOT NULL CHECK (reward_micros >= 0),
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,day)
);
CREATE TABLE payment_channels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, provider text NOT NULL CHECK (provider IN ('epay','alipay','wechat')),
    methods text[] NOT NULL, enabled boolean NOT NULL DEFAULT false, encrypted_config text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payment_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
    channel_id uuid NOT NULL REFERENCES payment_channels(id), method text NOT NULL CHECK (method IN ('alipay','wxpay')),
    amount_cents bigint NOT NULL CHECK (amount_cents > 0), status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','closed')),
    encrypted_config text NOT NULL, provider text NOT NULL, request_key uuid NOT NULL, request_hash text NOT NULL,
    trade_no text, payment_url text, expires_at timestamptz NOT NULL, paid_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,request_key), UNIQUE(channel_id,trade_no)
);
CREATE INDEX payment_orders_pending_idx ON payment_orders(expires_at) WHERE status='pending';
CREATE TABLE models (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(120) NOT NULL, display_name varchar(120) NOT NULL,
    capability text NOT NULL CHECK (capability IN ('image','text','video','audio')), sort_order integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','disabled')),
    price_per_image numeric(14,6), price_micros bigint NOT NULL DEFAULT 0 CHECK (price_micros >= 0),
    description text, config jsonb NOT NULL DEFAULT '{}', deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE channels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(120) NOT NULL, protocol text NOT NULL CHECK (protocol IN ('openai','gemini')),
    base_url text NOT NULL, encrypted_api_key text, api_key_hint text,
    status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('active','disabled','needs_attention')),
    timeout_ms integer NOT NULL DEFAULT 300000 CHECK (timeout_ms > 0), max_concurrency integer NOT NULL DEFAULT 20 CHECK (max_concurrency > 0),
    cooldown_seconds integer NOT NULL DEFAULT 120 CHECK (cooldown_seconds >= 0), cooldown_until timestamptz,
    last_success_at timestamptz, last_failure_at timestamptz, last_error_code text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE model_channels (
    model_id uuid NOT NULL REFERENCES models(id), channel_id uuid NOT NULL REFERENCES channels(id), upstream_model varchar(160) NOT NULL,
    priority integer NOT NULL DEFAULT 0, weight integer NOT NULL DEFAULT 100 CHECK (weight > 0), enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(model_id,channel_id)
);
CREATE TABLE media_objects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id), object_key text NOT NULL UNIQUE,
    original_name varchar(255) NOT NULL, mime_type varchar(80) NOT NULL, byte_size bigint NOT NULL,
    width integer, height integer, sha256 text NOT NULL, status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','deleting')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_owner_idx ON media_objects(owner_id,created_at DESC);
CREATE TABLE canvas_projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), title varchar(200) NOT NULL, snapshot jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canvas_projects_user_idx ON canvas_projects(user_id,updated_at DESC);
CREATE TABLE canvas_project_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id), title varchar(200) NOT NULL, note varchar(200), snapshot jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canvas_history_project_idx ON canvas_project_history(project_id,created_at DESC);
CREATE TABLE assets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id),
    scope text NOT NULL DEFAULT 'private' CHECK (scope IN ('private','public')), type text NOT NULL CHECK (type IN ('image','text','video','audio')),
    title varchar(200) NOT NULL, content text, media_id uuid REFERENCES media_objects(id), metadata jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assets_owner_idx ON assets(owner_id,updated_at DESC);
CREATE INDEX assets_public_idx ON assets(updated_at DESC) WHERE scope='public';
CREATE TABLE media_references (
    owner_kind text NOT NULL, owner_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES users(id), media_id uuid NOT NULL REFERENCES media_objects(id),
    position integer NOT NULL DEFAULT 0,
    PRIMARY KEY(owner_kind,owner_id,media_id)
);
CREATE INDEX media_references_media_idx ON media_references(media_id);
CREATE INDEX media_references_user_idx ON media_references(user_id,media_id);
CREATE TABLE conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), canvas_project_id uuid REFERENCES canvas_projects(id) ON DELETE SET NULL,
    title varchar(200) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES conversations(id), role text NOT NULL,
    content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), sequence bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX messages_conversation_idx ON messages(conversation_id,sequence);
CREATE TABLE generation_batches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), model_id uuid NOT NULL REFERENCES models(id),
    canvas_project_id uuid REFERENCES canvas_projects(id) ON DELETE SET NULL, capability text NOT NULL,
    prompt text NOT NULL, requested_count integer NOT NULL, parameters jsonb NOT NULL DEFAULT '{}',
    request_key uuid NOT NULL, request_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
    UNIQUE(user_id,request_key)
);
CREATE INDEX batches_user_idx ON generation_batches(user_id,created_at DESC);
CREATE TABLE generation_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid REFERENCES generation_batches(id), user_id uuid NOT NULL REFERENCES users(id),
    model_id uuid NOT NULL REFERENCES models(id), capability text NOT NULL, model_name text NOT NULL, model_display_name text NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','canceled')),
    sequence integer NOT NULL DEFAULT 0, run integer NOT NULL DEFAULT 1, prompt text NOT NULL, parameters jsonb NOT NULL DEFAULT '{}',
    price_micros bigint NOT NULL CHECK (price_micros >= 0), request_hash text, conversation_id uuid REFERENCES conversations(id),
    request_message_id uuid REFERENCES messages(id), response_message_id uuid REFERENCES messages(id), output_media_id uuid REFERENCES media_objects(id),
    channel_id uuid REFERENCES channels(id), upstream_task_id text, upstream_model text, worker_token uuid, channel_snapshot text,
    deadline timestamptz, available_at timestamptz NOT NULL DEFAULT now(), error_code text, error_message text,
    queued_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
);
CREATE INDEX tasks_queue_idx ON generation_tasks(available_at,queued_at) WHERE status='queued';
CREATE INDEX tasks_running_idx ON generation_tasks(deadline) WHERE status='running';
CREATE INDEX tasks_user_idx ON generation_tasks(user_id,queued_at DESC);
CREATE INDEX tasks_batch_idx ON generation_tasks(batch_id,sequence);
CREATE INDEX tasks_conversation_idx ON generation_tasks(conversation_id,queued_at DESC);
CREATE UNIQUE INDEX tasks_conversation_active_idx ON generation_tasks(conversation_id) WHERE status IN ('queued','running');
CREATE TABLE request_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id), type text NOT NULL, task_id uuid REFERENCES generation_tasks(id),
    model_id uuid REFERENCES models(id), model_name_snapshot text, model_display_name_snapshot text,
    channel_id uuid REFERENCES channels(id), channel_name_snapshot text, upstream_model text,
    status text NOT NULL, http_status integer, error_category text, error_message text, billed_amount numeric(14,6),
    started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, duration_ms integer
);
CREATE INDEX logs_user_idx ON request_logs(user_id,started_at DESC);
CREATE INDEX logs_time_idx ON request_logs(started_at DESC);
CREATE INDEX logs_channel_idx ON request_logs(channel_id,started_at DESC);
CREATE TABLE audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid REFERENCES users(id), action text NOT NULL, target text NOT NULL,
    detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_time_idx ON audit_logs(created_at DESC);
