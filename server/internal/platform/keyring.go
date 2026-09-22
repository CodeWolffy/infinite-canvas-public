package platform

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// rotateBatch 是单批重加密的行数；一个事务里分批处理，避免大表一次性锁住。
const rotateBatch = 500

// encryptedColumns 列出所有密文列。表名与列名都是代码内常量，不来自外部输入。
var encryptedColumns = []struct {
	Table, Column, Filter string
}{
	{"channel_keys", "encrypted_api_key", "coalesce(encrypted_api_key,'')<>''"},
	{"mail_outbox", "encrypted_message", "coalesce(encrypted_message,'')<>''"},
	{"generation_tasks", "channel_snapshot", "coalesce(channel_snapshot,'')<>''"},
	{"payment_channels", "encrypted_config", "coalesce(encrypted_config,'')<>''"},
	{"payment_orders", "encrypted_config", "coalesce(encrypted_config,'')<>''"},
	{"users", "encrypted_totp_secret", "coalesce(encrypted_totp_secret,'')<>''"},
	{"users", "encrypted_totp_pending", "coalesce(encrypted_totp_pending,'')<>''"},
}

// RotationResult 是一列的重加密统计，用于命令行输出。
type RotationResult struct {
	Table, Column string
	Rows          int64
}

// RotateKeys 用当前主密钥重新加密所有密文列；旧密文必须能由主密钥或上一把密钥解开，否则整表回滚。
func (a *App) RotateKeys(ctx context.Context) ([]RotationResult, error) {
	results := make([]RotationResult, 0, len(encryptedColumns)+1)
	for _, item := range encryptedColumns {
		count, err := a.rotateColumn(ctx, item.Table, item.Column, item.Filter)
		if err != nil {
			return results, fmt.Errorf("%s.%s: %w", item.Table, item.Column, err)
		}
		results = append(results, RotationResult{Table: item.Table, Column: item.Column, Rows: count})
	}
	count, err := a.rotateMailSettings(ctx)
	if err != nil {
		return results, fmt.Errorf("app_settings.mail: %w", err)
	}
	return append(results, RotationResult{Table: "app_settings", Column: "value.sealed", Rows: count}), nil
}

// rotateColumn 按 id 顺序分批重加密一列；id::text 只用于排序游标，不参与业务语义。
func (a *App) rotateColumn(ctx context.Context, table, column, filter string) (int64, error) {
	var total int64
	err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		cursor := "00000000-0000-0000-0000-000000000000"
		for {
			items, err := rows(ctx, tx, fmt.Sprintf("SELECT id::text AS id,%s AS value FROM %s WHERE %s AND id::text>$1 ORDER BY id LIMIT %d", column, table, filter, rotateBatch), cursor)
			if err != nil {
				return err
			}
			if len(items) == 0 {
				return nil
			}
			for _, item := range items {
				id := str(item["id"])
				if err = a.reseal(ctx, tx, fmt.Sprintf("UPDATE %s SET %s=$2 WHERE id=$1", table, column), id, str(item["value"])); err != nil {
					return fmt.Errorf("记录 %s: %w", id, err)
				}
				cursor, total = id, total+1
			}
		}
	})
	return total, err
}

// rotateMailSettings 重加密 app_settings 里 key='mail' 的 sealed 字段。
func (a *App) rotateMailSettings(ctx context.Context) (int64, error) {
	var total int64
	err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		var raw []byte
		if err := tx.QueryRow(ctx, "SELECT value FROM app_settings WHERE key='mail' FOR UPDATE").Scan(&raw); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			return err
		}
		var stored struct {
			Sealed string `json:"sealed"`
		}
		if err := json.Unmarshal(raw, &stored); err != nil || stored.Sealed == "" {
			return nil
		}
		plain, err := a.unseal(stored.Sealed)
		if err != nil {
			return err
		}
		sealed, err := a.seal(plain)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "UPDATE app_settings SET value=$1,updated_at=now() WHERE key='mail'", jsonBytes(Row{"sealed": sealed})); err != nil {
			return err
		}
		total = 1
		return nil
	})
	return total, err
}

// reseal 解开旧密文并用当前主密钥重新写入。
func (a *App) reseal(ctx context.Context, tx pgx.Tx, update, id, value string) error {
	plain, err := a.unseal(value)
	if err != nil {
		return err
	}
	sealed, err := a.seal(plain)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, update, id, sealed)
	return err
}
