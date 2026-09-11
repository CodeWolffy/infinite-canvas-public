-- 渠道故障冷却期支持管理员后台自定义配置，默认 120 秒
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "cooldown_seconds" integer NOT NULL DEFAULT 120;
