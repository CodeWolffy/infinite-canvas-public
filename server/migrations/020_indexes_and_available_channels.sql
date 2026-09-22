-- 热路径索引与「渠道可用」统一视图。
-- 判定条件原先在 content/generation/worker 中重复 7 份且互不一致，集中到视图后各查询只需附加冷却与排除条件。

CREATE INDEX IF NOT EXISTS request_logs_task_idx ON request_logs(task_id);
CREATE INDEX IF NOT EXISTS upstream_cost_task_idx ON upstream_cost_entries(task_id);
CREATE INDEX IF NOT EXISTS upstream_cost_channel_status_idx ON upstream_cost_entries(channel_id,status) INCLUDE(duration_ms);
CREATE INDEX IF NOT EXISTS generation_tasks_finished_idx ON generation_tasks(finished_at DESC);
CREATE INDEX IF NOT EXISTS generation_tasks_output_media_idx ON generation_tasks(output_media_id) WHERE output_media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_media_idx ON assets(media_id) WHERE media_id IS NOT NULL;

CREATE OR REPLACE VIEW available_model_channels AS
SELECT b.id AS binding_id, b.model_id, b.channel_id, b.priority, b.weight, b.upstream_model, b.cost_config, c.capability, c.protocol, c.cooldown_until
FROM model_channels b
JOIN channels c ON c.id=b.channel_id
JOIN models m ON m.id=b.model_id
WHERE b.enabled AND c.status='active' AND c.deleted_at IS NULL AND c.auto_disabled_at IS NULL
  AND m.status='published' AND m.deleted_at IS NULL
  AND c.capability=m.capability AND (c.protocol<>'anthropic' OR m.capability='text')
  AND EXISTS(SELECT 1 FROM channel_keys k WHERE k.channel_id=c.id AND k.status='active');
