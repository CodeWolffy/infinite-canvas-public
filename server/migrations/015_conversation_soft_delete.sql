ALTER TABLE conversations ADD COLUMN deleted_at timestamptz;
CREATE INDEX conversations_user_idx ON conversations(user_id,updated_at DESC) WHERE deleted_at IS NULL;
