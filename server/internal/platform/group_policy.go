package platform

import (
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
			StorageQuota int64    `json:"storageQuotaBytes" binding:"omitempty,min=0"`
		}](c)
		if err != nil {
			return nil, err
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
			result, err := tx.Exec(ctx, "UPDATE user_groups SET model_ids=$2::text[]::uuid[],storage_quota_bytes=$3 WHERE id=$1", id, input.ModelIDs, input.StorageQuota)
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
		items, err := rows(c.Request.Context(), a.DB, "SELECT a.id,a.actor_id,u.username,a.detail,a.created_at FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.action='sensitive.match' AND ($3='' OR a.detail->>'action'=$3) AND ($4='' OR a.detail->>'pattern' ILIKE '%'||$4||'%' OR u.username ILIKE '%'||$4||'%') ORDER BY a.created_at DESC,a.id LIMIT $1 OFFSET $2", limit, offset, c.Query("action"), c.Query("search"))
		return gin.H{"events": items}, err
	}))
}
