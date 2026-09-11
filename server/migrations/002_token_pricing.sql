-- 文本模型 token 级计价：单价按每百万 token 的微元数存储，NULL 表示沿用固定单次价格。
-- 缓存命中单价独立配置（参考 new-api 的 CacheRatio），NULL 时缓存 token 按输入单价收费。
ALTER TABLE models
    ADD COLUMN input_price_per_million bigint CHECK (input_price_per_million IS NULL OR input_price_per_million >= 0),
    ADD COLUMN output_price_per_million bigint CHECK (output_price_per_million IS NULL OR output_price_per_million >= 0),
    ADD COLUMN cached_price_per_million bigint CHECK (cached_price_per_million IS NULL OR cached_price_per_million >= 0);

-- 任务表保存计价快照与实际用量，结算时按实际 token 计费、冻结多退少补。
ALTER TABLE generation_tasks
    ADD COLUMN pricing_kind text NOT NULL DEFAULT 'fixed' CHECK (pricing_kind IN ('fixed','token')),
    ADD COLUMN input_price_per_million bigint,
    ADD COLUMN output_price_per_million bigint,
    ADD COLUMN cached_price_per_million bigint,
    ADD COLUMN prompt_tokens bigint,
    ADD COLUMN cached_tokens bigint,
    ADD COLUMN completion_tokens bigint,
    ADD COLUMN billed_micros bigint;

CREATE INDEX tasks_usage_idx ON generation_tasks(model_id, queued_at DESC) WHERE pricing_kind='token';
