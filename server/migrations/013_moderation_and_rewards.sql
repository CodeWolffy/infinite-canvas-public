-- 仅移除周期规则，历史领取记录、钱包和不可变账本均保留。
ALTER TABLE user_groups DROP COLUMN grant_amount_micros, DROP COLUMN grant_period,
    DROP COLUMN spend_limit_micros, DROP COLUMN spend_period;

ALTER TABLE sensitive_words DROP CONSTRAINT sensitive_words_action_check;
ALTER TABLE sensitive_words ADD CONSTRAINT sensitive_words_action_check CHECK (action IN ('block','review','log'));
CREATE TABLE moderation_reviews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
	request_snapshot jsonb NOT NULL,
    matches jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','canceled')),
    reviewed_by uuid REFERENCES users(id), note text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz
);
ALTER TABLE generation_tasks ADD COLUMN moderation_id uuid REFERENCES moderation_reviews(id);
ALTER TABLE generation_tasks DROP CONSTRAINT generation_tasks_status_check;
ALTER TABLE generation_tasks ADD CONSTRAINT generation_tasks_status_check CHECK (status IN ('reviewing','queued','running','succeeded','failed','canceled'));
DROP INDEX tasks_conversation_active_idx;
CREATE UNIQUE INDEX tasks_conversation_active_idx ON generation_tasks(conversation_id) WHERE status IN ('reviewing','queued','running');
CREATE INDEX tasks_moderation_idx ON generation_tasks(moderation_id);
CREATE INDEX moderation_pending_idx ON moderation_reviews(created_at) WHERE status='pending';

ALTER TABLE users ADD COLUMN referral_code text NOT NULL DEFAULT gen_random_uuid()::text UNIQUE;
CREATE TABLE referrals (
    user_id uuid PRIMARY KEY REFERENCES users(id), inviter_id uuid NOT NULL REFERENCES users(id),
    reward_micros bigint NOT NULL DEFAULT 0 CHECK (reward_micros>=0),
    created_at timestamptz NOT NULL DEFAULT now(), CHECK (user_id<>inviter_id)
);
CREATE INDEX referrals_inviter_idx ON referrals(inviter_id,created_at DESC);
