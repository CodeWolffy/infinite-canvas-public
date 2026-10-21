package platform

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// 与取消、结算保持 wallet -> task 锁顺序。自动重排保留提交标记，显式重试才开始新的一轮。
func (a *App) submitTask(ctx context.Context, original Row) (bool, error) {
	submitted := false
	err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		if err := lockWallet(ctx, tx, str(original["userId"])); err != nil {
			return err
		}
		task, err := one(ctx, tx, "SELECT status,worker_token,run,upstream_submitted_at FROM generation_tasks WHERE id=$1 FOR UPDATE", original["id"])
		if err != nil {
			return err
		}
		if task["status"] != "running" || str(task["workerToken"]) != str(original["workerToken"]) || integer(task["run"]) != integer(original["run"]) {
			return nil
		}
		if task["upstreamSubmittedAt"] == nil {
			if err = requireNoDebt(ctx, tx, str(original["userId"])); err != nil {
				return err
			}
		}
		_, err = tx.Exec(ctx, "UPDATE generation_tasks SET upstream_submitted_at=coalesce(upstream_submitted_at,now()) WHERE id=$1", original["id"])
		submitted = err == nil
		return err
	})
	return submitted && err == nil, err
}
