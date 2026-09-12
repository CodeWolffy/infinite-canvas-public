package platform

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/shopspring/decimal"
)

// groupDiscount 返回用户所在组的折扣（1 为原价）；未分组按默认组 1.0。
func (a *App) groupDiscount(ctx context.Context, q querier, user *User) (decimal.Decimal, error) {
	var discount decimal.Decimal
	err := q.QueryRow(ctx, "SELECT coalesce(g.discount,1) FROM users u LEFT JOIN user_groups g ON g.id=u.group_id WHERE u.id=$1", user.ID).Scan(&discount)
	if errors.Is(err, pgx.ErrNoRows) {
		return decimal.NewFromInt(1), nil
	}
	return discount, err
}

// 记录命中的规则及处理方式，不把完整用户提示词写入审计日志。
func (a *App) checkSensitive(ctx context.Context, text, userID string) (sensitiveDecision, error) {
	decision := sensitiveDecision{Matches: []Row{}}
	if strings.TrimSpace(text) == "" {
		return decision, nil
	}
	items, err := rows(ctx, a.DB, "SELECT id,pattern,action FROM sensitive_words ORDER BY created_at,id")
	if err != nil {
		return decision, err
	}
	lowered := strings.ToLower(text)
	for _, item := range items {
		pattern := str(item["pattern"])
		if pattern == "" {
			continue
		}
		if strings.Contains(lowered, strings.ToLower(pattern)) {
			decision.Matches = append(decision.Matches, item)
			if err := a.audit(ctx, a.DB, userID, "sensitive.match", str(item["id"]), Row{"pattern": pattern, "action": item["action"]}); err != nil {
				return decision, err
			}
			if item["action"] == "block" {
				decision.Action = "block"
			} else if item["action"] == "review" && decision.Action != "block" {
				decision.Action = "review"
			}
		}
	}
	return decision, nil
}

func (a *App) modelAccess(ctx context.Context, q querier, userID, modelID string) error {
	var allowed bool
	if err := q.QueryRow(ctx, "SELECT g.model_ids IS NULL OR $2::uuid=ANY(g.model_ids) FROM users u LEFT JOIN user_groups g ON g.id=u.group_id WHERE u.id=$1 AND u.status='active'", userID, modelID).Scan(&allowed); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return problem(403, "account_disabled", "账号不可用")
		}
		return err
	}
	if !allowed {
		return problem(403, "model_forbidden", "当前分组无权使用此模型")
	}
	return nil
}

func (a *App) groupRoutes(api *gin.RouterGroup) {
	// 兑换码充值：与签到入账一致走 changeWallet，唯一约束保证一个码每用户只入账一次。
	api.POST("/user/redeem", respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			Code string `json:"code" binding:"required,min=8,max=128"`
		}](c)
		if err != nil {
			return nil, err
		}
		u := currentUser(c)
		normalized := strings.TrimSpace(input.Code)
		var amount int64
		var repeated bool
		err = pgx.BeginFunc(c.Request.Context(), a.DB, func(tx pgx.Tx) error {
			if err := lockWallet(c.Request.Context(), tx, u.ID); err != nil {
				return err
			}
			var codeID string
			err := tx.QueryRow(c.Request.Context(), "UPDATE redeem_codes SET used_count=used_count+1 WHERE code_hash=$1 AND NOT disabled AND used_count<max_uses AND (expires_at IS NULL OR expires_at>now()) RETURNING id,amount_micros", hash(normalized)).Scan(&codeID, &amount)
			if errors.Is(err, pgx.ErrNoRows) {
				// 已兑换过的码给友好提示而不是“无效”。
				var used bool
				if err = tx.QueryRow(c.Request.Context(), "SELECT EXISTS(SELECT 1 FROM redeem_codes r JOIN redeem_uses u ON u.code_id=r.id AND u.user_id=$2 WHERE r.code_hash=$1)", hash(normalized), u.ID).Scan(&used); err == nil && used {
					repeated = true
				}
				return problem(400, "invalid_code", "兑换码无效、已过期或已用完")
			}
			if err != nil {
				return err
			}
			if _, err = tx.Exec(c.Request.Context(), "INSERT INTO redeem_uses(code_id,user_id) VALUES($1,$2)", codeID, u.ID); err != nil {
				var pg *pgconn.PgError
				if errors.As(err, &pg) && pg.Code == "23505" {
					repeated = true
					return problem(400, "invalid_code", "你已兑换过此兑换码")
				}
				return err
			}
			credited, err := changeWallet(c.Request.Context(), tx, u.ID, "recharge", "redeem:"+codeID, amount, 0, "兑换码充值")
			if err != nil || !credited {
				return err
			}
			return a.notifyCredit(c.Request.Context(), tx, u.ID, "recharge", amount)
		})
		if err != nil {
			return nil, err
		}
		return gin.H{"amount": money(amount), "alreadyRedeemed": repeated}, nil
	}))
}

func (a *App) groupAdminRoutes(admin *gin.RouterGroup) {
	admin.GET("/user-groups", respond(func(c *gin.Context) (any, error) {
		items, err := rows(c.Request.Context(), a.DB, `SELECT g.id,g.name,g.discount,to_json(g.model_ids) AS model_ids,g.storage_quota_bytes,g.created_at,(SELECT count(*) FROM users u WHERE u.group_id=g.id) AS member_count FROM user_groups g ORDER BY g.created_at`)
		return gin.H{"groups": items}, err
	}))
	admin.POST("/user-groups", respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			Name     string          `json:"name" binding:"required,max=80"`
			Discount decimal.Decimal `json:"discount" binding:"required"`
		}](c)
		if err != nil {
			return nil, err
		}
		if input.Discount.IsNegative() || input.Discount.GreaterThan(decimal.NewFromInt(10)) {
			return nil, problem(400, "invalid_discount", "折扣需在 0–10 之间")
		}
		ctx := c.Request.Context()
		group, err := one(ctx, a.DB, "INSERT INTO user_groups(name,discount) VALUES($1,$2) RETURNING id,name,discount,created_at", strings.TrimSpace(input.Name), input.Discount)
		if err != nil {
			return nil, err
		}
		return gin.H{"group": group}, a.audit(ctx, a.DB, currentUser(c).ID, "group.create", str(group["id"]), input)
	}))
	admin.PUT("/user-groups/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			Name     string          `json:"name" binding:"required,max=80"`
			Discount decimal.Decimal `json:"discount" binding:"required"`
		}](c)
		if err != nil {
			return nil, err
		}
		if input.Discount.IsNegative() || input.Discount.GreaterThan(decimal.NewFromInt(10)) {
			return nil, problem(400, "invalid_discount", "折扣需在 0–10 之间")
		}
		ctx := c.Request.Context()
		group, err := one(ctx, a.DB, "UPDATE user_groups SET name=$2,discount=$3 WHERE id=$1 RETURNING id,name,discount,created_at", id, strings.TrimSpace(input.Name), input.Discount)
		if err != nil {
			return nil, err
		}
		return gin.H{"group": group}, a.audit(ctx, a.DB, currentUser(c).ID, "group.update", id, input)
	}))
	admin.DELETE("/user-groups/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			var count int
			if err := tx.QueryRow(ctx, "SELECT count(*) FROM users WHERE group_id=$1", id).Scan(&count); err != nil {
				return err
			}
			if count > 0 {
				return problem(409, "group_in_use", "请先把组内用户移到其他分组")
			}
			result, err := tx.Exec(ctx, "DELETE FROM user_groups WHERE id=$1", id)
			if err != nil {
				return err
			}
			if result.RowsAffected() != 1 {
				return notFound
			}
			return a.audit(ctx, tx, currentUser(c).ID, "group.delete", id, gin.H{})
		})
		return nil, err
	}))
	// 用户分组调整
	admin.PATCH("/users/:id/group", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			GroupID *string `json:"groupId"`
		}](c)
		if err != nil {
			return nil, err
		}
		if input.GroupID != nil {
			if !validID(*input.GroupID) {
				return nil, problem(400, "invalid_id", "分组编号不正确")
			}
		}
		ctx := c.Request.Context()
		var u User
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			result, err := tx.Exec(ctx, "UPDATE users SET group_id=$2,updated_at=now() WHERE id=$1", id, input.GroupID)
			if err != nil {
				return err
			}
			if result.RowsAffected() != 1 {
				return notFound
			}
			u, err = scanUser(tx.QueryRow(ctx, "SELECT "+userColumns+" FROM users u LEFT JOIN user_groups g ON g.id=u.group_id WHERE u.id=$1", id))
			if err != nil {
				return err
			}
			return a.audit(ctx, tx, currentUser(c).ID, "user.group", id, input)
		})
		if err != nil {
			return nil, err
		}
		return gin.H{"user": u}, nil
	}))

	// 兑换码管理：与邀请码同模式，完整码只在创建后显示一次。
	admin.GET("/redeem-codes", respond(func(c *gin.Context) (any, error) {
		limit, offset := pagination(c)
		items, err := rows(c.Request.Context(), a.DB, "SELECT id,code_hint,note,amount_micros,max_uses,used_count,expires_at,disabled,created_at FROM redeem_codes ORDER BY created_at DESC LIMIT $1 OFFSET $2", limit, offset)
		for _, row := range items {
			row["amount"] = money(integer(row["amountMicros"]))
			delete(row, "amountMicros")
		}
		return gin.H{"codes": items}, err
	}))
	admin.POST("/redeem-codes", respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			Note      string     `json:"note"`
			Amount    string     `json:"amount" binding:"required"`
			MaxUses   int        `json:"maxUses" binding:"required,min=1"`
			Count     int        `json:"count"`
			ExpiresAt *time.Time `json:"expiresAt"`
		}](c)
		if err != nil {
			return nil, err
		}
		if input.ExpiresAt != nil && !input.ExpiresAt.After(time.Now()) {
			return nil, problem(400, "invalid_expiry", "兑换码有效期必须晚于现在")
		}
		amount, err := amountUnits(input.Amount, moneyScale)
		if err != nil {
			return nil, err
		}
		if amount <= 0 {
			return nil, problem(400, "invalid_amount", "兑换码金额必须大于 0")
		}
		count := input.Count
		if count <= 0 {
			count = 1
		}
		if count > 100 {
			return nil, problem(400, "invalid_count", "单次最多批量生成 100 张兑换码")
		}
		ctx := c.Request.Context()
		secrets := make([]string, 0, count)
		items := make([]Row, 0, count)
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			for i := 0; i < count; i++ {
				codeBytes := make([]byte, 24)
				if _, err := rand.Read(codeBytes); err != nil {
					return err
				}
				code := "CD-" + base64.RawURLEncoding.EncodeToString(codeBytes)
				created, err := one(ctx, tx, "INSERT INTO redeem_codes(code_hash,code_hint,created_by,note,amount_micros,max_uses,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,code_hint,note,max_uses,used_count,expires_at,disabled,created_at", hash(code), code[:8]+"…", currentUser(c).ID, input.Note, amount, input.MaxUses, input.ExpiresAt)
				if err != nil {
					return err
				}
				secrets = append(secrets, code)
				items = append(items, created)
			}
			return a.audit(ctx, tx, currentUser(c).ID, "redeem.create", fmt.Sprintf("count:%d", count), gin.H{"amount": money(amount), "maxUses": input.MaxUses, "count": count})
		})
		if err != nil {
			return nil, err
		}
		secret := ""
		if len(secrets) > 0 {
			secret = secrets[0]
		}
		var firstCode Row
		if len(items) > 0 {
			firstCode = items[0]
		}
		return gin.H{"code": firstCode, "secret": secret, "codes": items, "secrets": secrets}, nil
	}))
	admin.PATCH("/redeem-codes/:id", respond(func(c *gin.Context) (any, error) {
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
			result, err := tx.Exec(ctx, "UPDATE redeem_codes SET disabled=$2 WHERE id=$1", id, input.Disabled)
			if err != nil {
				return err
			}
			if result.RowsAffected() != 1 {
				return notFound
			}
			return a.audit(ctx, tx, currentUser(c).ID, "redeem.status", id, input)
		})
		return nil, err
	}))

	// 敏感词管理
	admin.GET("/sensitive-words", respond(func(c *gin.Context) (any, error) {
		items, err := rows(c.Request.Context(), a.DB, "SELECT id,pattern,action,created_at FROM sensitive_words ORDER BY created_at DESC")
		return gin.H{"words": items}, err
	}))
	admin.POST("/sensitive-words", respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			Pattern string `json:"pattern" binding:"required,min=1,max=200"`
			Action  string `json:"action" binding:"required,oneof=block review log"`
		}](c)
		if err != nil {
			return nil, err
		}
		pattern := strings.TrimSpace(input.Pattern)
		if pattern == "" {
			return nil, problem(400, "invalid_pattern", "关键词不能为空")
		}
		ctx := c.Request.Context()
		word, err := one(ctx, a.DB, "INSERT INTO sensitive_words(pattern,action) VALUES($1,$2) ON CONFLICT(pattern) DO UPDATE SET action=excluded.action RETURNING id,pattern,action,created_at", pattern, input.Action)
		if err != nil {
			return nil, err
		}
		return gin.H{"word": word}, a.audit(ctx, a.DB, currentUser(c).ID, "sensitive.upsert", str(word["id"]), input)
	}))
	admin.DELETE("/sensitive-words/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		result, err := a.DB.Exec(ctx, "DELETE FROM sensitive_words WHERE id=$1", id)
		if err != nil {
			return nil, err
		}
		if result.RowsAffected() != 1 {
			return nil, notFound
		}
		return nil, a.audit(ctx, a.DB, currentUser(c).ID, "sensitive.delete", id, gin.H{})
	}))

	// 渠道余额：复用主动检测的查询实现；不支持的渠道返回明确提示。
	admin.POST("/channels/:id/balance", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
		defer cancel()
		row, err := one(ctx, a.DB, "SELECT * FROM channels WHERE id=$1 AND deleted_at IS NULL", id)
		if err != nil {
			return nil, err
		}
		ch, err := a.channelFromRow(row)
		if err != nil {
			return nil, err
		}
		if err = a.selectChannelKey(c.Request.Context(), &ch, nil, true); err != nil {
			return nil, err
		}
		info, err := a.channelBalance(ctx, ch)
		if err != nil {
			return nil, problem(502, "balance_unavailable", "渠道余额查询失败："+err.Error())
		}
		if info["balance"] == nil {
			// usage 端点缺失时至少返回额度。
			return gin.H{"quota": info["quota"]}, nil
		}
		return gin.H{"balance": info["balance"], "quota": info["quota"], "used": info["used"]}, nil
	}))
}
