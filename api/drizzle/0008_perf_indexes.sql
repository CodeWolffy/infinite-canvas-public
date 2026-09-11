-- 孤儿媒体清理每天扫一次 status='ready' + reference_count=0 + created_at<=cutoff，
-- 原有索引都以 owner_id 开头用不上，这里加部分索引把全表扫描收敛成小范围索引扫描。
CREATE INDEX IF NOT EXISTS "media_objects_orphan_idx" ON "media_objects" ("created_at")
  WHERE "status" = 'ready' AND "reference_count" = 0;
--> statement-breakpoint
-- 素材列表按 updated_at desc, id desc 分页，原本没有可用的排序索引，每页都要排整个可见集合。
CREATE INDEX IF NOT EXISTS "assets_updated_pagination_idx" ON "assets" ("updated_at" DESC, "id" DESC);
--> statement-breakpoint
-- 统计分析按 queued_at 范围过滤所有任务，原有索引未覆盖单一时间范围扫描。
CREATE INDEX IF NOT EXISTS "generation_tasks_queued_at_idx" ON "generation_tasks" ("queued_at");
