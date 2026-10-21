-- 实际费用完整入账；只有冻结余额仍受非负约束，后续到账自然抵扣欠费。
ALTER TABLE wallets DROP CONSTRAINT wallets_balance_micros_check;

ALTER TABLE generation_tasks ADD COLUMN upstream_submitted_at timestamptz;
-- 非空旧库保守处理已经尝试过的任务，防止升级后把在途消费当作可退款任务。
UPDATE generation_tasks SET upstream_submitted_at=coalesce(started_at,queued_at)
WHERE attempt_count>0 OR upstream_task_id IS NOT NULL OR partial_text<>'' OR upstream_completed;

CREATE INDEX payment_orders_user_pending_idx ON payment_orders(user_id) WHERE status='pending';
