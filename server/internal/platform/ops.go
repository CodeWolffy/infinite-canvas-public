package platform

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

const (
	checkRetentionDays        = 30
	notificationRetentionDays = 90
	auditRetentionDays        = 365
	lowBalanceMicros          = moneyScale
)

func queryTime(c *gin.Context, key string) (*time.Time, error) {
	value := c.Query(key)
	if value == "" {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return nil, problem(400, "invalid_date", "时间范围格式不正确")
	}
	return &parsed, nil
}

func lockStorage(ctx context.Context, tx pgx.Tx, userID string) error {
	_, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "storage:"+userID)
	return err
}

func (a *App) enforceStorageQuota(ctx context.Context, q querier, userID string, extra int64) error {
	if extra < 0 {
		extra = 0
	}
	row, err := one(ctx, q, `SELECT g.storage_quota_bytes FROM users u JOIN user_groups g ON g.id=u.group_id WHERE u.id=$1 AND g.storage_quota_bytes>0`, userID)
	if errors.Is(err, notFound) {
		return nil
	}
	if err != nil {
		return err
	}
	var used int64
	if err = q.QueryRow(ctx, "SELECT coalesce(sum(byte_size),0) FROM media_objects WHERE owner_id=$1 AND status IN ('ready','uploading')", userID).Scan(&used); err != nil {
		return err
	}
	if used+extra > integer(row["storageQuotaBytes"]) {
		return problem(413, "storage_quota", "当前分组存储已达上限，请删除不用的文件或联系管理员")
	}
	return nil
}

func storageQuotaView(ctx context.Context, q querier, userID string) (int64, int64, error) {
	var used int64
	if err := q.QueryRow(ctx, "SELECT coalesce(sum(byte_size),0) FROM media_objects WHERE owner_id=$1 AND status='ready'", userID).Scan(&used); err != nil {
		return 0, 0, err
	}
	row, err := one(ctx, q, `SELECT g.storage_quota_bytes FROM users u JOIN user_groups g ON g.id=u.group_id WHERE u.id=$1 AND g.storage_quota_bytes>0`, userID)
	if errors.Is(err, notFound) {
		return used, 0, nil
	}
	if err != nil {
		return 0, 0, err
	}
	return used, integer(row["storageQuotaBytes"]), nil
}

func (a *App) notifyCredit(ctx context.Context, q querier, userID, kind string, amount int64) error {
	if amount <= 0 {
		return nil
	}
	title := map[string]string{"recharge": "余额已到账", "grant": "公益额度已发放", "checkin": "签到奖励已到账", "referral": "邀请返利已到账", "adjustment": "管理员已调整余额"}[kind]
	if title == "" {
		title = "余额已增加"
	}
	return a.notification(ctx, q, userID, kind+":"+userID+":"+fmt.Sprint(time.Now().UnixNano()), "wallet."+kind, title, "到账 ¥"+money(amount)+"，可在钱包明细中核对。")
}

func (a *App) notifyLowBalance(ctx context.Context, q querier, userID string) error {
	var balance int64
	if err := q.QueryRow(ctx, "SELECT balance_micros FROM wallets WHERE user_id=$1", userID).Scan(&balance); err != nil || balance >= lowBalanceMicros {
		return err
	}
	day := time.Now().In(time.FixedZone("CST", 8*3600)).Format("2006-01-02")
	return a.notification(ctx, q, userID, "balance-low:"+userID+":"+day, "wallet.low", "可用余额偏低", "当前可用余额 ¥"+money(balance)+"，生成可能因余额不足被拒绝。")
}

func (a *App) notifySecurity(ctx context.Context, q querier, userID, key, title, content string) error {
	return a.notification(ctx, q, userID, key, "auth.security", title, content)
}

func (a *App) notifyLogin(ctx context.Context, q querier, userID, token, ip, agent string) error {
	var known bool
	if err := q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM sessions WHERE user_id=$1 AND token_hash<>$2 AND revoked_at IS NULL AND expires_at>now() AND ip=$3 AND user_agent=$4)", userID, hash(token), ip, agent).Scan(&known); err != nil || known {
		return err
	}
	return a.notifySecurity(ctx, q, userID, "login:"+hash(token), "账号已在新设备登录", "IP："+ip+"\n设备："+agent)
}

func (a *App) notifyNoChannel(ctx context.Context, modelID string) {
	var name string
	if err := a.DB.QueryRow(ctx, "SELECT coalesce(nullif(display_name,''),name) FROM models WHERE id=$1", modelID).Scan(&name); err != nil {
		name = modelID
	}
	hour := time.Now().In(time.FixedZone("CST", 8*3600)).Format("2006-01-02-15")
	_ = a.notification(ctx, a.DB, "", "no-channel:"+modelID+":"+hour, "channel.unavailable", "模型暂无可用渠道", name+" 当前没有可用渠道，用户生成会被拒绝。")
}

func (a *App) opsRoutes(admin *gin.RouterGroup) {
	admin.GET("/status", respond(func(c *gin.Context) (any, error) {
		ctx := c.Request.Context()
		if err := a.DB.Ping(ctx); err != nil {
			return nil, problem(503, "unavailable", "数据库不可用")
		}
		redisOK := a.Redis != nil && a.Redis.Ping(ctx).Err() == nil
		storageOK := false
		if a.S3 != nil {
			ok, err := a.S3.BucketExists(ctx, a.Config.Bucket)
			storageOK = err == nil && ok
		}
		queue, err := one(ctx, a.DB, "SELECT count(*) FILTER(WHERE status='queued')::bigint AS queued,count(*) FILTER(WHERE status='running')::bigint AS running FROM generation_tasks")
		if err != nil {
			return nil, err
		}
		mail, err := one(ctx, a.DB, "SELECT count(*) FILTER(WHERE status='queued')::bigint AS queued,count(*) FILTER(WHERE status='sending')::bigint AS sending,count(*) FILTER(WHERE status='failed')::bigint AS failed FROM mail_outbox")
		if err != nil {
			return nil, err
		}
		channels, err := one(ctx, a.DB, "SELECT count(*) FILTER(WHERE status='active')::bigint AS active,count(*) FILTER(WHERE cooldown_until>now())::bigint AS cooling,count(*) FILTER(WHERE monitor_status='failed')::bigint AS monitor_failed,count(*) FILTER(WHERE monitor_token IS NOT NULL)::bigint AS checking FROM channels")
		if err != nil {
			return nil, err
		}
		started := a.startedAt
		if started.IsZero() {
			started = time.Now()
		}
		return gin.H{
			"startedAt": started, "workerConcurrency": a.Config.WorkerConcurrency,
			"database": true, "redis": redisOK, "storage": storageOK,
			"queue": queue, "mail": mail, "channels": channels,
		}, nil
	}))
	admin.POST("/channels/check-all", respond(func(c *gin.Context) (any, error) {
		result, err := a.DB.Exec(c.Request.Context(), `UPDATE channels SET next_check_at=now() WHERE status='active' AND (
			(jsonb_typeof(monitoring->'bindingIds')='array' AND jsonb_array_length(monitoring->'bindingIds')>0)
			OR coalesce((monitoring->>'checkModels')::boolean,false)
			OR (monitoring ? 'balanceThreshold' AND monitoring->>'balanceThreshold' NOT IN ('','null')))`)
		if err != nil {
			return nil, err
		}
		if err = a.audit(c.Request.Context(), a.DB, currentUser(c).ID, "channel.check_all", "channels", gin.H{"queued": result.RowsAffected()}); err != nil {
			return nil, err
		}
		return gin.H{"queued": result.RowsAffected()}, nil
	}))
}

func walletSummary(ctx context.Context, q querier, userID string, from, to *time.Time) (Row, error) {
	row, err := one(ctx, q, `SELECT
		coalesce(-sum(delta_balance+delta_frozen) FILTER(WHERE kind='charge'),0)::bigint AS spent,
		coalesce(sum(delta_balance) FILTER(WHERE kind='recharge'),0)::bigint AS recharge,
		coalesce(sum(delta_balance) FILTER(WHERE kind IN('grant','referral')),0)::bigint AS grants,
		coalesce(sum(delta_balance) FILTER(WHERE kind='checkin'),0)::bigint AS checkin,
		coalesce(sum(delta_balance) FILTER(WHERE kind='adjustment'),0)::bigint AS adjustment
		FROM wallet_entries WHERE user_id=$1 AND ($2::timestamptz IS NULL OR created_at>=$2) AND ($3::timestamptz IS NULL OR created_at<=$3)`, userID, from, to)
	if err != nil {
		return nil, err
	}
	for _, key := range []string{"spent", "recharge", "grants", "checkin", "adjustment"} {
		row[key] = money(integer(row[key]))
	}
	return row, nil
}
