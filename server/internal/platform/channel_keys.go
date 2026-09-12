package platform

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

const channelKeyCounts = `(SELECT count(*) FROM channel_keys k WHERE k.channel_id=c.id) AS key_count,
	(SELECT count(*) FROM channel_keys k WHERE k.channel_id=c.id AND k.status='active') AS active_key_count`

func recordKeyFailure(ctx context.Context, q querier, ch channel, failure *upstreamError) error {
	if ch.KeyID == "" || failure.Category != "authentication" {
		return nil
	}
	_, err := q.Exec(ctx, "UPDATE channel_keys SET status='disabled',disabled_reason='authentication',last_failure_at=now(),last_error_code='authentication' WHERE id=$1 AND status='active'", ch.KeyID)
	return err
}

func recordKeySuccess(ctx context.Context, q querier, ch channel, started time.Time) error {
	if ch.KeyID == "" {
		return nil
	}
	_, err := q.Exec(ctx, `UPDATE channel_keys SET last_success_at=now(),last_error_code=NULL,status='active',disabled_reason=NULL
		WHERE id=$1 AND (status='active' OR disabled_reason='authentication') AND (last_failure_at IS NULL OR last_failure_at<$2)`, ch.KeyID, started)
	return err
}

func (a *App) addChannelKeys(ctx context.Context, tx pgx.Tx, channelID string, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	existing, err := rows(ctx, tx, "SELECT encrypted_api_key FROM channel_keys WHERE channel_id=$1", channelID)
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, row := range existing {
		key, err := a.unseal(str(row["encryptedApiKey"]))
		if err != nil {
			return err
		}
		seen[key] = true
	}
	for _, value := range keys {
		key := strings.TrimSpace(value)
		if key == "" || seen[key] {
			continue
		}
		sealed, err := a.seal(key)
		if err != nil {
			return err
		}
		hint := "已配置"
		if len(key) > 4 {
			hint = "••••" + key[len(key)-4:]
		}
		if _, err = tx.Exec(ctx, "INSERT INTO channel_keys(channel_id,encrypted_api_key,key_hint) VALUES($1,$2,$3)", channelID, sealed, hint); err != nil {
			return err
		}
		seen[key] = true
	}
	return nil
}

// PostgreSQL 行锁保证多实例轮询顺序一致；选中后立即释放锁，密钥仅保存在服务端。
func (a *App) selectChannelKey(ctx context.Context, ch *channel, excluded []string, probe bool) error {
	return pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		row, err := one(ctx, tx, `SELECT id,encrypted_api_key FROM channel_keys
			WHERE channel_id=$1 AND (status='active' OR ($3 AND disabled_reason='authentication'))
			AND NOT (id=ANY(coalesce($2::text[]::uuid[],'{}')))
			ORDER BY (status='active') DESC,CASE WHEN $4='random' THEN random() ELSE 0 END,last_used_at NULLS FIRST,id
			LIMIT 1 FOR UPDATE SKIP LOCKED`, ch.ID, excluded, probe, ch.KeyStrategy)
		if errors.Is(err, notFound) {
			return &upstreamError{Category: "no_key", Message: "渠道暂无可用密钥"}
		}
		if err != nil {
			return err
		}
		ch.APIKey, err = a.unseal(str(row["encryptedApiKey"]))
		if err != nil {
			return err
		}
		ch.KeyID = str(row["id"])
		_, err = tx.Exec(ctx, "UPDATE channel_keys SET last_used_at=now() WHERE id=$1", ch.KeyID)
		return err
	})
}

func (a *App) channelKeyRoutes(admin *gin.RouterGroup) {
	admin.GET("/channels/:id/keys", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		items, err := rows(c.Request.Context(), a.DB, `SELECT k.id,k.key_hint,k.status,k.disabled_reason,k.last_used_at,k.last_failure_at,k.last_success_at,k.last_error_code,k.created_at
			FROM channel_keys k JOIN channels c ON c.id=k.channel_id WHERE c.id=$1 AND c.deleted_at IS NULL ORDER BY k.created_at,k.id`, id)
		return gin.H{"keys": items}, err
	}))
	admin.PATCH("/channels/:id/keys/:keyId", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		keyID, err := idParam(c, "keyId")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			Status string `json:"status" binding:"required,oneof=active disabled"`
		}](c)
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			result, err := tx.Exec(ctx, `UPDATE channel_keys SET status=$3,disabled_reason=CASE WHEN $3='disabled' THEN 'manual' ELSE NULL END,last_error_code=NULL
				WHERE channel_id=$1 AND id=$2 AND EXISTS(SELECT 1 FROM channels WHERE id=$1 AND deleted_at IS NULL)`, id, keyID, input.Status)
			if err != nil {
				return err
			}
			if result.RowsAffected() != 1 {
				return notFound
			}
			return a.audit(ctx, tx, currentUser(c).ID, "channel.key_status", keyID, input)
		})
		return nil, err
	}))
	admin.DELETE("/channels/:id/keys/:keyId", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		keyID, err := idParam(c, "keyId")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			result, err := tx.Exec(ctx, "DELETE FROM channel_keys WHERE channel_id=$1 AND id=$2", id, keyID)
			if err != nil {
				return err
			}
			if result.RowsAffected() != 1 {
				return notFound
			}
			return a.audit(ctx, tx, currentUser(c).ID, "channel.key_delete", keyID, gin.H{"channelId": id})
		})
		return nil, err
	}))
}
