package platform

import (
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// 任务状态与永久账本使用同一数据库快照；不把尚未结算的预计金额当作消费。
func (a *App) taskBilling(c *gin.Context) (any, error) {
	id, err := idParam(c, "id")
	if err != nil {
		return nil, err
	}
	ctx, userID := c.Request.Context(), currentUser(c).ID
	var result Row
	err = pgx.BeginTxFunc(ctx, a.DB, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		task, err := one(ctx, tx, "SELECT id,status,run FROM generation_tasks WHERE id=$1 AND user_id=$2", id, userID)
		if err != nil {
			return err
		}
		attempts, err := rows(ctx, tx, `SELECT split_part(reference,':',2)::integer AS run,
			coalesce(sum(delta_frozen) FILTER(WHERE kind='hold'),0)::bigint AS estimated,
			coalesce(sum(-delta_balance::numeric-delta_frozen) FILTER(WHERE kind='charge'),0)::bigint AS charged,
			coalesce(sum(greatest(delta_balance,0)) FILTER(WHERE kind IN('charge','release')),0)::bigint AS refunded,
			coalesce(sum(greatest(-delta_balance::numeric,0)) FILTER(WHERE kind='charge'),0)::bigint AS additional,
			bool_or(kind IN('charge','release')) AS settled,min(created_at) AS created_at,max(created_at) AS updated_at
			FROM wallet_entries WHERE user_id=$1 AND kind IN('hold','charge','release') AND reference LIKE $2
			GROUP BY reference ORDER BY run DESC`, userID, id+":%")
		if err != nil {
			return err
		}
		total := decimal.Zero
		var current Row
		for _, attempt := range attempts {
			total = total.Add(decimal.NewFromInt(integer(attempt["charged"])))
			for _, field := range []string{"estimated", "charged", "refunded", "additional"} {
				attempt[field] = modelPrice(integer(attempt[field]))
			}
			if attempt["settled"] != true {
				attempt["charged"] = nil
			}
			if integer(attempt["run"]) == integer(task["run"]) {
				current = attempt
			}
		}
		result = Row{"taskId": id, "status": task["status"], "current": current, "attempts": attempts, "totalCharged": total.Div(decimal.NewFromInt(moneyScale)).String()}
		return nil
	})
	return result, err
}
