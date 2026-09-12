package platform

import (
	"context"
	"errors"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

func (a *App) creditReferral(ctx context.Context, tx pgx.Tx, userID, code string) error {
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
	settings, err := a.settings(ctx, tx)
	if err != nil {
		return err
	}
	var amount int64
	if settings.ReferralEnabled {
		amount, err = amountUnits(settings.ReferralReward, moneyScale)
		if err != nil || amount < 0 {
			return problem(503, "invalid_referral_settings", "邀请奖励配置不正确，请联系管理员")
		}
	}
	result, err := tx.Exec(ctx, "INSERT INTO referrals(user_id,inviter_id,reward_micros) VALUES($1,$2,$3) ON CONFLICT(user_id) DO NOTHING", userID, inviter["id"], amount)
	if err != nil || result.RowsAffected() == 0 || amount == 0 {
		return err
	}
	credited, err := changeWallet(ctx, tx, str(inviter["id"]), "referral", userID, amount, 0, "邀请新用户注册奖励（永久余额）")
	if err != nil || !credited {
		return err
	}
	return a.notifyCredit(ctx, tx, str(inviter["id"]), "referral", amount)
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
		return gin.H{"code": code, "url": a.Config.PublicURL + "/login?ref=" + code, "enabled": settings.ReferralEnabled, "reward": settings.ReferralReward, "summary": summary, "referrals": items}, err
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
