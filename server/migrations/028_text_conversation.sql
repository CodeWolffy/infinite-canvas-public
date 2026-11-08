ALTER TABLE conversations
    ADD COLUMN pinned boolean NOT NULL DEFAULT false,
    ADD COLUMN archived_at timestamptz,
    ADD COLUMN model_id uuid REFERENCES models(id),
    ADD COLUMN parameters jsonb NOT NULL DEFAULT '{}';

-- 会话设置独立于任务保留期；只搬运仍存在的最新快照，不推测已清理的配置。
UPDATE conversations c SET model_id=t.model_id,parameters=t.parameters
FROM (
    SELECT DISTINCT ON (conversation_id) conversation_id,model_id,parameters
    FROM generation_tasks WHERE conversation_id IS NOT NULL
    ORDER BY conversation_id,queued_at DESC,id DESC
) t WHERE c.id=t.conversation_id;

ALTER TABLE messages ADD COLUMN superseded_at timestamptz;
ALTER TABLE generation_tasks
    ADD COLUMN finish_reason text NOT NULL DEFAULT '',
    ADD COLUMN action text NOT NULL DEFAULT '' CHECK (action IN ('','edit','regenerate')),
    ADD COLUMN target_message_id uuid REFERENCES messages(id);

CREATE INDEX messages_active_conversation_idx ON messages(conversation_id,sequence) WHERE superseded_at IS NULL;
CREATE INDEX tasks_response_message_idx ON generation_tasks(response_message_id) WHERE response_message_id IS NOT NULL;
CREATE INDEX conversations_sidebar_idx ON conversations(user_id,(archived_at IS NOT NULL),pinned DESC,updated_at DESC,id DESC) WHERE deleted_at IS NULL;
