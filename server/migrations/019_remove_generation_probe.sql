-- 生成检测已移除：周期检查只保留零成本的模型列表与渠道余额。
-- 目标状态是「对象不存在」，用 IF EXISTS 让迁移在对象已缺失时也能安全通过，避免升级被卡住。
ALTER TABLE channels DROP COLUMN IF EXISTS consecutive_check_failures;
DROP TABLE IF EXISTS channel_binding_checks;
UPDATE channels SET monitoring = monitoring - 'bindingIds' - 'prompt' - 'parameters' - 'autoDisableAfter';
