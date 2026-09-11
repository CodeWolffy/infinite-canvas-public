-- 多模型检测的全部成本记录通过 monitor_token 关联同一次检测执行，进程中断恢复时一并结束。
ALTER TABLE upstream_cost_entries ADD COLUMN monitor_token uuid;
CREATE INDEX upstream_cost_monitor_idx ON upstream_cost_entries(monitor_token) WHERE status='running';
