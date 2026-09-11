package platform

import (
	"errors"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

func (a *App) groupPolicyRoutes(admin *gin.RouterGroup) {
	admin.PUT("/user-groups/:id/policy", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			ModelIDs     []string `json:"modelIds" binding:"omitempty,dive,uuid"`
			GrantAmount  string   `json:"grantAmount" binding:"required"`
			GrantPeriod  string   `json:"grantPeriod" binding:"required,oneof=day week month"`
			SpendLimit   string   `json:"spendLimit"`
			SpendPeriod  string   `json:"spendPeriod" binding:"omitempty,oneof=day week month"`
			StorageQuota int64    `json:"storageQuotaBytes" binding:"omitempty,min=0"`
		}](c)
		if err != nil {
			return nil, err
		}
		amount, err := amountUnits(input.GrantAmount, moneyScale)
		if err != nil {
			return nil, err
		}
		if amount < 0 {
			return nil, problem(400, "invalid_amount", "公益额度不能为负数")
		}
		if input.SpendLimit == "" {
			input.SpendLimit = "0"
		}
		if input.SpendPeriod == "" {
			input.SpendPeriod = "month"
		}
		spend, err := amountUnits(input.SpendLimit, moneyScale)
		if err != nil {
			return nil, err
		}
		if spend < 0 {
			return nil, problem(400, "invalid_amount", "消费上限不能为负数")
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if len(input.ModelIDs) > 0 {
				var count int
				if err := tx.QueryRow(ctx, "SELECT count(*) FROM models WHERE id=ANY($1::text[]::uuid[]) AND deleted_at IS NULL", input.ModelIDs).Scan(&count); err != nil {
					return err
				}
				if count != len(input.ModelIDs) {
					return problem(400, "invalid_models", "模型不存在或重复")
				}
			}
			result, err := tx.Exec(ctx, "UPDATE user_groups SET model_ids=$2::text[]::uuid[],grant_amount_micros=$3,grant_period=$4,spend_limit_micros=$5,spend_period=$6,storage_quota_bytes=$7 WHERE id=$1", id, input.ModelIDs, amount, input.GrantPeriod, spend, input.SpendPeriod, input.StorageQuota)
			if err != nil {
				return err
			}
			if result.RowsAffected() != 1 {
				return notFound
			}
			return a.audit(ctx, tx, currentUser(c).ID, "group.policy", id, input)
		})
		return nil, err
	}))
	admin.GET("/sensitive-events", respond(func(c *gin.Context) (any, error) {
		limit, offset := pagination(c)
		items, err := rows(c.Request.Context(), a.DB, "SELECT a.id,a.actor_id,u.username,a.detail,a.created_at FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.action='sensitive.match' ORDER BY a.created_at DESC,a.id LIMIT $1 OFFSET $2", limit, offset)
		return gin.H{"events": items}, err
	}))
}

const grantSelect = "SELECT g.id AS group_id,g.name AS group_name,g.grant_amount_micros AS amount_micros,g.grant_period AS period,date_trunc(g.grant_period,now() AT TIME ZONE 'Asia/Shanghai')::date::text AS period_start FROM users u JOIN user_groups g ON g.id=u.group_id WHERE u.id=$1 AND g.grant_amount_micros>0"

func (a *App) grantRoutes(api *gin.RouterGroup) {
	api.GET("/user/group-grant", respond(func(c *gin.Context) (any, error) {
		ctx, u := c.Request.Context(), currentUser(c)
		grant, err := one(ctx, a.DB, grantSelect, u.ID)
		if errors.Is(err, notFound) {
			return gin.H{"grant": nil}, nil
		}
		if err != nil {
			return nil, err
		}
		var claimed bool
		if err = a.DB.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM group_grant_claims WHERE user_id=$1 AND period=$2 AND period_start=$3::date)", u.ID, grant["period"], grant["periodStart"]).Scan(&claimed); err != nil {
			return nil, err
		}
		grant["amount"], grant["claimed"] = money(integer(grant["amountMicros"])), claimed
		delete(grant, "amountMicros")
		return gin.H{"grant": grant}, nil
	}))
	api.POST("/user/group-grant/claim", respond(func(c *gin.Context) (any, error) {
		ctx, u := c.Request.Context(), currentUser(c)
		var amount int64
		var repeated bool
		err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if err := lockWallet(ctx, tx, u.ID); err != nil {
				return err
			}
			grant, err := one(ctx, tx, grantSelect+" FOR SHARE OF u,g", u.ID)
			if errors.Is(err, notFound) {
				return problem(409, "grant_unavailable", "当前分组未开启公益额度")
			}
			if err != nil {
				return err
			}
			err = tx.QueryRow(ctx, "SELECT amount_micros FROM group_grant_claims WHERE user_id=$1 AND period=$2 AND period_start=$3::date", u.ID, grant["period"], grant["periodStart"]).Scan(&amount)
			if err == nil {
				repeated = true
				return nil
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			amount = integer(grant["amountMicros"])
			if _, err = tx.Exec(ctx, "INSERT INTO group_grant_claims(user_id,group_id,period,period_start,amount_micros) VALUES($1,$2,$3,$4::date,$5)", u.ID, grant["groupId"], grant["period"], grant["periodStart"], amount); err != nil {
				return err
			}
			credited, err := changeWallet(ctx, tx, u.ID, "grant", str(grant["period"])+":"+str(grant["periodStart"]), amount, 0, "周期公益额度")
			if err != nil || !credited {
				return err
			}
			return a.notifyCredit(ctx, tx, u.ID, "grant", amount)
		})
		return gin.H{"amount": money(amount), "alreadyClaimed": repeated}, err
	}))
}
