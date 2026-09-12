package platform

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

const moneyScale int64 = 1_000_000

type PlatformSettings struct {
	GenerationEnabled   bool   `json:"generationEnabled"`
	CheckinEnabled      bool   `json:"checkinEnabled"`
	RewardMin           string `json:"rewardMin"`
	RewardMax           string `json:"rewardMax"`
	UserRPM             int    `json:"userRPM"`
	IPRPM               int    `json:"ipRPM"`
	ActiveTasks         int    `json:"activeTasks"`
	PaymentOrderMinutes int    `json:"paymentOrderMinutes"`
	MaxAttempts         int    `json:"maxAttempts" binding:"min=1"`
	ReferralEnabled     bool   `json:"referralEnabled"`
	ReferralReward      string `json:"referralReward"`
}

var defaultSettings = PlatformSettings{GenerationEnabled: true, RewardMin: "0", RewardMax: "0", UserRPM: 10, IPRPM: 60, ActiveTasks: 20, PaymentOrderMinutes: 30, MaxAttempts: 3, ReferralReward: "0"}

func (a *App) settings(ctx context.Context, q querier) (PlatformSettings, error) {
	var raw []byte
	value := defaultSettings
	err := q.QueryRow(ctx, "SELECT value FROM app_settings WHERE key='platform'").Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return value, nil
	}
	if err != nil {
		return value, err
	}
	err = json.Unmarshal(raw, &value)
	return value, err
}
func amountUnits(value string, scale int64) (int64, error) {
	d, err := decimal.NewFromString(value)
	if err != nil {
		return 0, problem(400, "invalid_amount", "金额格式不正确")
	}
	scaled := d.Mul(decimal.NewFromInt(scale))
	if !scaled.Equal(scaled.Truncate(0)) {
		return 0, problem(400, "invalid_amount", "金额精度超出允许范围")
	}
	n, err := strconv.ParseInt(scaled.String(), 10, 64)
	if err != nil {
		return 0, problem(400, "invalid_amount", "金额超出范围")
	}
	return n, nil
}
func money(n int64) string {
	return decimal.NewFromInt(n).Div(decimal.NewFromInt(moneyScale)).StringFixed(6)
}
func walletView(row Row) Row {
	return Row{"balance": money(integer(row["balanceMicros"])), "frozen": money(integer(row["frozenMicros"])), "updatedAt": row["updatedAt"]}
}
func lockWallet(ctx context.Context, tx pgx.Tx, userID string) error {
	_, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "wallet:"+userID)
	return err
}

// 每笔余额变动与不可变账本一起提交。余额不由 Redis 或浏览器推算。
func changeWallet(ctx context.Context, tx pgx.Tx, userID, kind, reference string, balanceDelta, frozenDelta int64, note string) (bool, error) {
	if err := lockWallet(ctx, tx, userID); err != nil {
		return false, err
	}
	var exists bool
	if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM wallet_entries WHERE user_id=$1 AND kind=$2 AND reference=$3)", userID, kind, reference).Scan(&exists); err != nil {
		return false, err
	}
	if exists {
		return false, nil
	}
	var balance, frozen int64
	err := tx.QueryRow(ctx, "UPDATE wallets SET balance_micros=balance_micros+$2,frozen_micros=frozen_micros+$3,updated_at=now() WHERE user_id=$1 AND balance_micros+$2>=0 AND frozen_micros+$3>=0 RETURNING balance_micros,frozen_micros", userID, balanceDelta, frozenDelta).Scan(&balance, &frozen)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, problem(402, "insufficient_balance", "可用余额不足")
	}
	if err != nil {
		return false, err
	}
	_, err = tx.Exec(ctx, "INSERT INTO wallet_entries(user_id,kind,reference,delta_balance,delta_frozen,balance_after,frozen_after,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", userID, kind, reference, balanceDelta, frozenDelta, balance, frozen, note)
	return err == nil, err
}
func ledgerView(items []Row) []Row {
	for _, row := range items {
		for _, key := range []string{"deltaBalance", "deltaFrozen", "balanceAfter", "frozenAfter"} {
			row[key] = money(integer(row[key]))
		}
	}
	return items
}

func (a *App) walletRoutes(api *gin.RouterGroup) {
	api.GET("/user/wallet", respond(func(c *gin.Context) (any, error) {
		ctx := c.Request.Context()
		u := currentUser(c)
		wallet, err := one(ctx, a.DB, "SELECT * FROM wallets WHERE user_id=$1", u.ID)
		if err != nil {
			return nil, err
		}
		settings, err := a.settings(ctx, a.DB)
		if err != nil {
			return nil, err
		}
		var day string
		var checked bool
		err = a.DB.QueryRow(ctx, "SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text,EXISTS(SELECT 1 FROM checkins WHERE user_id=$1 AND day=(now() AT TIME ZONE 'Asia/Shanghai')::date)", u.ID).Scan(&day, &checked)
		if err != nil {
			return nil, err
		}
		channels, err := rows(ctx, a.DB, "SELECT id,name,provider,methods FROM payment_channels WHERE enabled ORDER BY created_at")
		if err != nil {
			return nil, err
		}
		now := time.Now().In(time.FixedZone("CST", 8*3600))
		monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
		monthEnd := monthStart.AddDate(0, 1, 0)
		from, to := monthStart.UTC(), monthEnd.UTC()
		summary, err := walletSummary(ctx, a.DB, u.ID, &from, &to)
		if err != nil {
			return nil, err
		}
		return gin.H{"wallet": walletView(wallet), "checkin": gin.H{"enabled": settings.CheckinEnabled, "day": day, "checkedIn": checked, "rewardMin": settings.RewardMin, "rewardMax": settings.RewardMax, "timezone": "Asia/Shanghai"}, "paymentChannels": channels, "summary": summary}, nil
	}))
	api.POST("/user/checkin", respond(func(c *gin.Context) (any, error) {
		ctx := c.Request.Context()
		u := currentUser(c)
		var reward int64
		var repeated bool
		err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if err := lockWallet(ctx, tx, u.ID); err != nil {
				return err
			}
			var day string
			if err := tx.QueryRow(ctx, "SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text").Scan(&day); err != nil {
				return err
			}
			err := tx.QueryRow(ctx, "SELECT reward_micros FROM checkins WHERE user_id=$1 AND day=$2::date", u.ID, day).Scan(&reward)
			if err == nil {
				repeated = true
				return nil
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			settings, err := a.settings(ctx, tx)
			if err != nil {
				return err
			}
			if !settings.CheckinEnabled {
				return problem(409, "checkin_disabled", "管理员尚未开启签到奖励")
			}
			min, err := amountUnits(settings.RewardMin, moneyScale)
			if err != nil {
				return err
			}
			max, err := amountUnits(settings.RewardMax, moneyScale)
			if err != nil {
				return err
			}
			width := new(big.Int).Sub(big.NewInt(max), big.NewInt(min))
			width.Add(width, big.NewInt(1))
			draw, err := rand.Int(rand.Reader, width)
			if err != nil {
				return err
			}
			reward = new(big.Int).Add(draw, big.NewInt(min)).Int64()
			if _, err = tx.Exec(ctx, "INSERT INTO checkins(user_id,day,reward_micros) VALUES($1,$2::date,$3)", u.ID, day, reward); err != nil {
				return err
			}
			credited, err := changeWallet(ctx, tx, u.ID, "checkin", day, reward, 0, "每日签到")
			if err != nil || !credited {
				return err
			}
			return a.notifyCredit(ctx, tx, u.ID, "checkin", reward)
		})
		if err != nil {
			return nil, err
		}
		return gin.H{"reward": money(reward), "alreadyCheckedIn": repeated}, nil
	}))
	api.GET("/user/wallet/entries", respond(func(c *gin.Context) (any, error) {
		ctx := c.Request.Context()
		limit, offset := pagination(c)
		kind := c.Query("kind")
		from, err := queryTime(c, "from")
		if err != nil {
			return nil, err
		}
		to, err := queryTime(c, "to")
		if err != nil {
			return nil, err
		}
		filter := "user_id=$1 AND ($2='' OR kind=$2) AND ($3::timestamptz IS NULL OR created_at>=$3) AND ($4::timestamptz IS NULL OR created_at<=$4)"
		items, err := rows(ctx, a.DB, "SELECT * FROM wallet_entries WHERE "+filter+" ORDER BY created_at DESC,id LIMIT $5 OFFSET $6", currentUser(c).ID, kind, from, to, limit, offset)
		if err != nil {
			return nil, err
		}
		var count int64
		err = a.DB.QueryRow(ctx, "SELECT count(*) FROM wallet_entries WHERE "+filter, currentUser(c).ID, kind, from, to).Scan(&count)
		return gin.H{"entries": ledgerView(items), "total": count}, err
	}))
	api.POST("/user/payment-orders", respond(a.createPaymentOrder))
	api.GET("/user/payment-orders", respond(func(c *gin.Context) (any, error) {
		limit, offset := pagination(c)
		items, err := rows(c.Request.Context(), a.DB, "SELECT id,channel_id,method,amount_cents,status,trade_no,expires_at,paid_at,created_at FROM payment_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3", currentUser(c).ID, limit, offset)
		for _, row := range items {
			row["amount"] = decimal.NewFromInt(integer(row["amountCents"])).Div(decimal.NewFromInt(100)).StringFixed(2)
			delete(row, "amountCents")
		}
		return gin.H{"orders": items}, err
	}))
	api.GET("/user/payment-orders/:id", respond(a.getPaymentOrder))
	api.POST("/user/payment-orders/:id/refresh", respond(a.refreshPaymentOrder))
}

func (a *App) billingAdminRoutes(admin *gin.RouterGroup) {
	admin.GET("/platform-settings", respond(func(c *gin.Context) (any, error) {
		settings, err := a.settings(c.Request.Context(), a.DB)
		return gin.H{"settings": settings}, err
	}))
	admin.PUT("/platform-settings", respond(func(c *gin.Context) (any, error) {
		settings, err := body[PlatformSettings](c)
		if err != nil {
			return nil, err
		}
		min, err := amountUnits(settings.RewardMin, moneyScale)
		if err != nil {
			return nil, err
		}
		max, err := amountUnits(settings.RewardMax, moneyScale)
		if err != nil {
			return nil, err
		}
		reward, err := amountUnits(settings.ReferralReward, moneyScale)
		if err != nil || reward < 0 {
			return nil, problem(400, "invalid_settings", "邀请奖励必须为非负金额")
		}
		if min < 0 || max < min || settings.UserRPM < 0 || settings.IPRPM < 0 || settings.ActiveTasks < 0 || settings.PaymentOrderMinutes <= 0 {
			return nil, problem(400, "invalid_settings", "奖励范围、频控或订单有效期不正确")
		}
		if int64(settings.PaymentOrderMinutes) > int64((1<<63-1)/time.Minute) {
			return nil, problem(400, "invalid_settings", "订单有效期超出范围")
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, "INSERT INTO app_settings(key,value) VALUES('platform',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()", jsonBytes(settings)); err != nil {
				return err
			}
			return a.audit(ctx, tx, currentUser(c).ID, "platform.settings", "platform", settings)
		})
		return gin.H{"settings": settings}, err
	}))
	admin.GET("/invitations", respond(func(c *gin.Context) (any, error) {
		limit, offset := pagination(c)
		items, err := rows(c.Request.Context(), a.DB, "SELECT id,code_hint,note,max_uses,used_count,expires_at,disabled,created_at FROM invitations ORDER BY created_at DESC LIMIT $1 OFFSET $2", limit, offset)
		return gin.H{"invitations": items}, err
	}))
	admin.POST("/invitations", respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			Note      string     `json:"note"`
			MaxUses   int        `json:"maxUses" binding:"required,min=1"`
			ExpiresAt *time.Time `json:"expiresAt"`
		}](c)
		if err != nil {
			return nil, err
		}
		if input.ExpiresAt != nil && !input.ExpiresAt.After(time.Now()) {
			return nil, problem(400, "invalid_expiry", "邀请码有效期必须晚于现在")
		}
		codeBytes := make([]byte, 24)
		if _, err = rand.Read(codeBytes); err != nil {
			return nil, err
		}
		code := base64.RawURLEncoding.EncodeToString(codeBytes)
		ctx := c.Request.Context()
		var invitation Row
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			var err error
			invitation, err = one(ctx, tx, "INSERT INTO invitations(code_hash,code_hint,created_by,note,max_uses,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,code_hint,note,max_uses,used_count,expires_at,disabled,created_at", hash(code), code[:6]+"…", currentUser(c).ID, input.Note, input.MaxUses, input.ExpiresAt)
			if err != nil {
				return err
			}
			return a.audit(ctx, tx, currentUser(c).ID, "invitation.create", str(invitation["id"]), gin.H{"maxUses": input.MaxUses})
		})
		return gin.H{"invitation": invitation, "code": code}, err
	}))
	admin.PATCH("/invitations/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			Disabled bool `json:"disabled"`
		}](c)
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			result, err := tx.Exec(ctx, "UPDATE invitations SET disabled=$2 WHERE id=$1", id, input.Disabled)
			if err != nil {
				return err
			}
			if result.RowsAffected() != 1 {
				return notFound
			}
			return a.audit(ctx, tx, currentUser(c).ID, "invitation.status", id, input)
		})
		return nil, err
	}))
	admin.GET("/wallet-entries", respond(func(c *gin.Context) (any, error) {
		limit, offset := pagination(c)
		id := c.Query("userId")
		if id != "" && !validID(id) {
			return nil, problem(400, "invalid_id", "用户编号不正确")
		}
		items, err := rows(c.Request.Context(), a.DB, "SELECT e.*,u.username,u.display_name FROM wallet_entries e JOIN users u ON u.id=e.user_id WHERE ($1='' OR e.user_id::text=$1) ORDER BY e.created_at DESC,e.id LIMIT $2 OFFSET $3", id, limit, offset)
		return gin.H{"entries": ledgerView(items)}, err
	}))
	admin.POST("/users/:id/balance", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			Amount    string `json:"amount" binding:"required"`
			Note      string `json:"note" binding:"required"`
			RequestID string `json:"requestId" binding:"required,uuid"`
		}](c)
		if err != nil {
			return nil, err
		}
		amount, err := amountUnits(input.Amount, moneyScale)
		if err != nil {
			return nil, err
		}
		if amount == 0 || strings.TrimSpace(input.Note) == "" {
			return nil, problem(400, "invalid_amount", "请输入非零金额与调整原因")
		}
		reference := uuid.MustParse(input.RequestID).String()
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if err := lockWallet(ctx, tx, id); err != nil {
				return err
			}
			var oldAmount int64
			var oldNote string
			err := tx.QueryRow(ctx, "SELECT delta_balance,note FROM wallet_entries WHERE user_id=$1 AND kind='adjustment' AND reference=$2", id, reference).Scan(&oldAmount, &oldNote)
			if err == nil {
				if oldAmount != amount || oldNote != input.Note {
					return problem(409, "idempotency_conflict", "同一请求编号不能用于不同调整")
				}
				return nil
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			credited, err := changeWallet(ctx, tx, id, "adjustment", reference, amount, 0, input.Note)
			if err != nil {
				return err
			}
			if credited && amount > 0 {
				if err = a.notifyCredit(ctx, tx, id, "adjustment", amount); err != nil {
					return err
				}
			}
			return a.audit(ctx, tx, currentUser(c).ID, "wallet.adjust", id, gin.H{"amount": money(amount), "note": input.Note, "requestId": reference})
		})
		return nil, err
	}))
	admin.GET("/audit-logs", respond(func(c *gin.Context) (any, error) {
		limit, offset := pagination(c)
		items, err := rows(c.Request.Context(), a.DB, "SELECT a.*,u.username FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT $1 OFFSET $2", limit, offset)
		return gin.H{"logs": items}, err
	}))
	a.paymentAdminRoutes(admin)
}
