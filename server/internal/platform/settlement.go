package platform

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// 结算只读取明确的数据库字段；金额和执行租约不再依赖 map 的键名与动态类型。
type settlementTask struct {
	ID             string  `db:"id"`
	UserID         string  `db:"user_id"`
	Status         string  `db:"status"`
	WorkerToken    *string `db:"worker_token"`
	Run            int64   `db:"run"`
	Capability     string  `db:"capability"`
	ConversationID string  `db:"conversation_id"`
	PriceMicros    int64   `db:"price_micros"`
	PricingKind    string  `db:"pricing_kind"`
	InputPrice     int64   `db:"input_price_per_million"`
	CachedPrice    *int64  `db:"cached_price_per_million"`
	OutputPrice    int64   `db:"output_price_per_million"`
	PricePerSecond *int64  `db:"price_per_second"`
	Seconds        string  `db:"seconds"`
}

func (t settlementTask) reference() string { return t.ID + ":" + str(t.Run) }

func loadSettlementTask(ctx context.Context, tx pgx.Tx, id string) (settlementTask, error) {
	items, err := tx.Query(ctx, `SELECT id::text,user_id::text,status,worker_token::text,run,capability,coalesce(conversation_id::text,'') AS conversation_id,
		price_micros,pricing_kind,coalesce(input_price_per_million,0) AS input_price_per_million,cached_price_per_million,
		coalesce(output_price_per_million,0) AS output_price_per_million,price_per_second,coalesce(seconds::text,'') AS seconds
		FROM generation_tasks WHERE id=$1 FOR UPDATE`, id)
	if err != nil {
		return settlementTask{}, err
	}
	return pgx.CollectExactlyOneRow(items, pgx.RowToStructByName[settlementTask])
}
