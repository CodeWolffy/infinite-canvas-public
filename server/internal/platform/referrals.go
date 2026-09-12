package platform

import (
	"context"
	"errors"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

func (a *App) bindReferral(ctx context.Context, tx pgx.Tx, userID, code string) error {
	if code == "" {
		return nil
	}
	inviter, err := one(ctx, tx, "SELECT id FROM users WHERE referral_code=$1 AND status='active' AND id<>$2", code, userID)
	if errors.Is(err, notFound) {
		return problem(400, "invalid_referral", "推荐码无效，请核对邀请链接")
	}
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, "INSERT INTO referrals(user_id,inviter_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING", userID, inviter["id"])
	return err
}

// 仅在真实充值入账的事务中返利，每笔支付订单只产生一条邀请返利账本。
func (a *App) creditReferral(ctx context.Context, tx pgx.Tx, userID, orderID string, paidMicros int64) error {
	referral, err := one(ctx, tx, "SELECT inviter_id FROM referrals WHERE user_id=$1", userID)
	if errors.Is(err, notFound) {
		return nil
	}
	if err != nil {
		return err
	}
	settings, err := a.settings(ctx, tx)
	if err != nil || !settings.ReferralEnabled {
		return err
	}
	percent, err := decimal.NewFromString(settings.ReferralPercent)
	if err != nil || percent.IsNegative() {
		return problem(503, "invalid_referral_settings", "邀请返利比例配置不正确，请联系管理员")
	}
	amount, err := roundedMicros(decimal.NewFromInt(paidMicros).Mul(percent).Shift(-2).Truncate(0))
	if err != nil || amount == 0 {
		return err
	}
	inviterID := str(referral["inviterId"])
	credited, err := changeWallet(ctx, tx, inviterID, "referral", orderID, amount, 0, "好友充值 ¥"+modelPrice(paidMicros)+"，按 "+percent.String()+"% 返利（永久余额）")
	if err != nil || !credited {
		return err
	}
	if _, err = tx.Exec(ctx, "UPDATE referrals SET reward_micros=reward_micros+$2 WHERE user_id=$1", userID, amount); err != nil {
		return err
	}
	return a.notifyCredit(ctx, tx, inviterID, "referral", amount)
}

func (a *App) referralRoutes(api, admin *gin.RouterGroup) {
	api.GET("/user/referrals", respond(func(c *gin.Context) (any, error) {
		ctx, u := c.Request.Context(), currentUser(c)
		settings, err := a.settings(ctx, a.DB)
		if err != nil {
			return nil, err
		}
		var code string
		if err = a.DB.QueryRow(ctx, "SELECT referral_code FROM users WHERE id=$1", u.ID).Scan(&code); err != nil {
			return nil, err
		}
		summary, err := one(ctx, a.DB, "SELECT count(*) AS invited,coalesce(sum(reward_micros),0)::bigint AS earned FROM referrals WHERE inviter_id=$1", u.ID)
		if err != nil {
			return nil, err
		}
		summary["earned"] = money(integer(summary["earned"]))
		limit, offset := pagination(c)
		items, err := rows(ctx, a.DB, "SELECT r.user_id AS id,u.display_name,r.reward_micros,r.created_at FROM referrals r JOIN users u ON u.id=r.user_id WHERE inviter_id=$1 ORDER BY r.created_at DESC,r.user_id LIMIT $2 OFFSET $3", u.ID, limit, offset)
		for _, item := range items {
			item["reward"] = money(integer(item["rewardMicros"]))
			delete(item, "rewardMicros")
		}
		return gin.H{"code": code, "url": a.Config.PublicURL + "/login?ref=" + code, "enabled": settings.ReferralEnabled, "percent": settings.ReferralPercent, "summary": summary, "referrals": items}, err
	}))
	admin.GET("/referrals", respond(func(c *gin.Context) (any, error) {
		limit, offset := pagination(c)
		items, err := rows(c.Request.Context(), a.DB, `SELECT r.user_id AS id,r.created_at,r.reward_micros,u.username,inviter.username AS inviter_name
			FROM referrals r JOIN users u ON u.id=r.user_id JOIN users inviter ON inviter.id=r.inviter_id
			WHERE ($1='' OR inviter.username ILIKE '%'||$1||'%' OR u.username ILIKE '%'||$1||'%') ORDER BY r.created_at DESC,r.user_id LIMIT $2 OFFSET $3`, c.Query("search"), limit, offset)
		for _, item := range items {
			item["reward"] = money(integer(item["rewardMicros"]))
			delete(item, "rewardMicros")
		}
		return gin.H{"referrals": items}, err
	}))
}
