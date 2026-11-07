package platform

import (
	"context"
	"errors"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

// projectRoleExpression 统一列表与单画布鉴权：仅资源本人为 owner，其余授权取最高角色。
// alias 与 user 只接受代码中的 SQL 标识符和占位符，不接受请求输入。
func projectRoleExpression(alias, user string) string {
	return `CASE WHEN ` + alias + `.user_id=` + user + ` THEN 'owner'
		WHEN EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=` + alias + `.workspace_id AND wm.user_id=` + user + ` AND wm.role IN ('owner','editor'))
			OR EXISTS(SELECT 1 FROM canvas_members cm WHERE cm.project_id=` + alias + `.id AND cm.user_id=` + user + ` AND cm.status='accepted' AND cm.role='editor') THEN 'editor'
		WHEN EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=` + alias + `.workspace_id AND wm.user_id=` + user + `)
			OR EXISTS(SELECT 1 FROM canvas_members cm WHERE cm.project_id=` + alias + `.id AND cm.user_id=` + user + ` AND cm.status='accepted') THEN 'viewer'
		ELSE '' END`
}

func canvasMemberRole(ctx context.Context, q querier, id, userID string) (string, error) {
	var role string
	err := q.QueryRow(ctx, "SELECT "+projectRoleExpression("p", "$2")+" FROM canvas_projects p WHERE p.id=$1", id, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return role, err
}

// recordCanvasAccess 不保存 IP、token 或快照；授权变更与记录在同一事务内提交。
func recordCanvasAccess(ctx context.Context, q querier, projectID, actorID, action string) error {
	_, err := q.Exec(ctx, "INSERT INTO canvas_access_logs(project_id,actor_id,action) VALUES($1,$2,$3)", projectID, nullable(actorID), action)
	return err
}

func lockCanvasOwner(ctx context.Context, tx pgx.Tx, id, userID string) error {
	_, err := one(ctx, tx, "SELECT id FROM canvas_projects WHERE id=$1 AND user_id=$2 FOR UPDATE", id, userID)
	return err
}

const canvasMemberColumns = `cm.user_id,u.username,u.display_name,cm.role,cm.status,'direct' AS source,
	CASE WHEN inviter.id IS NULL THEN NULL ELSE jsonb_build_object('userId',inviter.id,'username',inviter.username,'displayName',inviter.display_name) END AS invited_by`

func (a *App) canvasMemberRoutes(api *gin.RouterGroup) {
	api.GET("/canvas-projects/:id/collaboration", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		ctx, userID := c.Request.Context(), currentUser(c).ID
		if err = projectAccess(ctx, a.DB, id, userID); err != nil {
			return nil, err
		}
		result, err := one(ctx, a.DB, `SELECT jsonb_build_object('userId',u.id,'username',u.username,'displayName',u.display_name) AS owner,
			p.user_id=$2 AS can_manage,CASE WHEN w.id IS NULL THEN NULL ELSE jsonb_build_object('id',w.id,'name',w.name) END AS workspace
			FROM canvas_projects p JOIN users u ON u.id=p.user_id LEFT JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=$1`, id, userID)
		if err != nil {
			return nil, err
		}
		members, err := rows(ctx, a.DB, `SELECT u.id AS user_id,u.username,u.display_name,'owner' AS role,'accepted' AS status,'owner' AS source,NULL::jsonb AS invited_by
			FROM canvas_projects p JOIN users u ON u.id=p.user_id WHERE p.id=$1
			UNION ALL SELECT u.id,u.username,u.display_name,CASE WHEN wm.role='owner' THEN 'editor' ELSE wm.role END,'accepted','workspace',NULL::jsonb
			FROM canvas_projects p JOIN workspace_members wm ON wm.workspace_id=p.workspace_id JOIN users u ON u.id=wm.user_id WHERE p.id=$1 AND u.id<>p.user_id
			UNION ALL SELECT `+canvasMemberColumns+` FROM canvas_members cm JOIN users u ON u.id=cm.user_id LEFT JOIN users inviter ON inviter.id=cm.invited_by
			WHERE cm.project_id=$1 ORDER BY source,username`, id)
		if err != nil {
			return nil, err
		}
		share, err := currentShare(ctx, a.DB, "canvas", id)
		if err != nil {
			return nil, err
		}
		result["members"], result["share"] = members, share
		return result, nil
	}))
	api.POST("/canvas-projects/:id/members", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			Username string `json:"username" binding:"required,max=64"`
			Role     string `json:"role" binding:"omitempty,oneof=editor viewer"`
		}](c)
		if err != nil {
			return nil, err
		}
		if input.Role == "" {
			input.Role = "viewer"
		}
		ctx, ownerID := c.Request.Context(), currentUser(c).ID
		var member Row
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if err := lockCanvasOwner(ctx, tx, id, ownerID); err != nil {
				return err
			}
			target, err := one(ctx, tx, "SELECT id,username,display_name FROM users WHERE username=$1 AND status='active'", strings.ToLower(strings.TrimSpace(input.Username)))
			if errors.Is(err, notFound) {
				return problem(404, "user_not_found", "未找到该用户")
			}
			if err != nil {
				return err
			}
			if str(target["id"]) == ownerID {
				return problem(403, "owner_role_protected", "不能修改画布所有者的角色")
			}
			member, err = one(ctx, tx, `INSERT INTO canvas_members(project_id,user_id,role,invited_by) VALUES($1,$2,$3,$4)
				ON CONFLICT(project_id,user_id) DO NOTHING RETURNING user_id,role,status,created_at`, id, target["id"], input.Role, ownerID)
			if errors.Is(err, notFound) {
				return problem(409, "member_exists", "该用户已是成员或已有待接受的邀请")
			}
			if err != nil {
				return err
			}
			member["username"], member["displayName"], member["source"] = target["username"], target["displayName"], "direct"
			return recordCanvasAccess(ctx, tx, id, ownerID, "member_invited")
		})
		return gin.H{"member": member}, err
	}))
	api.PATCH("/canvas-projects/:id/members/:userId", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		userID, err := idParam(c, "userId")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			Role string `json:"role" binding:"required,oneof=editor viewer"`
		}](c)
		if err != nil {
			return nil, err
		}
		ctx, ownerID := c.Request.Context(), currentUser(c).ID
		var member Row
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if err := lockCanvasOwner(ctx, tx, id, ownerID); err != nil {
				return err
			}
			if userID == ownerID {
				return problem(403, "owner_role_protected", "不能修改画布所有者的角色")
			}
			var err error
			member, err = one(ctx, tx, "UPDATE canvas_members SET role=$3,updated_at=now() WHERE project_id=$1 AND user_id=$2 RETURNING user_id,role,status", id, userID, input.Role)
			if err != nil {
				return err
			}
			return recordCanvasAccess(ctx, tx, id, ownerID, "member_role_changed")
		})
		if err == nil {
			a.publishCanvasChange(ctx, id)
		}
		return gin.H{"member": member}, err
	}))
	api.DELETE("/canvas-projects/:id/members/:userId", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		userID, err := idParam(c, "userId")
		if err != nil {
			return nil, err
		}
		ctx, ownerID := c.Request.Context(), currentUser(c).ID
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if err := lockCanvasOwner(ctx, tx, id, ownerID); err != nil {
				return err
			}
			if userID == ownerID {
				return problem(403, "owner_role_protected", "不能移除画布所有者")
			}
			if _, err := one(ctx, tx, "DELETE FROM canvas_members WHERE project_id=$1 AND user_id=$2 RETURNING user_id", id, userID); err != nil {
				return err
			}
			return recordCanvasAccess(ctx, tx, id, ownerID, "member_removed")
		})
		if err == nil {
			a.publishCanvasChange(ctx, id)
		}
		return nil, err
	}))
	api.GET("/canvas-invitations", respond(func(c *gin.Context) (any, error) {
		items, err := rows(c.Request.Context(), a.DB, `SELECT cm.project_id,p.title,cm.role,cm.created_at,
			CASE WHEN u.id IS NULL THEN NULL ELSE jsonb_build_object('userId',u.id,'username',u.username,'displayName',u.display_name) END AS invited_by
			FROM canvas_members cm JOIN canvas_projects p ON p.id=cm.project_id LEFT JOIN users u ON u.id=cm.invited_by
			WHERE cm.user_id=$1 AND cm.status='pending' ORDER BY cm.created_at DESC,cm.project_id`, currentUser(c).ID)
		return gin.H{"invitations": items}, err
	}))
	api.POST("/canvas-projects/:id/invitation", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			Accept *bool `json:"accept" binding:"required"`
		}](c)
		if err != nil {
			return nil, err
		}
		ctx, userID := c.Request.Context(), currentUser(c).ID
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if _, err := one(ctx, tx, "SELECT id FROM canvas_projects WHERE id=$1 FOR UPDATE", id); err != nil {
				return err
			}
			query, action := "DELETE FROM canvas_members WHERE project_id=$1 AND user_id=$2 AND status='pending' RETURNING user_id", "invitation_rejected"
			if *input.Accept {
				query, action = "UPDATE canvas_members SET status='accepted',updated_at=now() WHERE project_id=$1 AND user_id=$2 AND status='pending' RETURNING user_id", "invitation_accepted"
			}
			if _, err := one(ctx, tx, query, id, userID); err != nil {
				return err
			}
			return recordCanvasAccess(ctx, tx, id, userID, action)
		})
		if err == nil {
			a.publishCanvasChange(ctx, id)
		}
		return nil, err
	}))
	api.GET("/canvas-projects/:id/access-log", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		if err = shareTargetAccess(ctx, a.DB, "canvas", id, currentUser(c).ID); err != nil {
			return nil, err
		}
		var total int
		if err = a.DB.QueryRow(ctx, "SELECT count(*) FROM canvas_access_logs WHERE project_id=$1", id).Scan(&total); err != nil {
			return nil, err
		}
		limit, offset := paginationWith(c, 200, 500)
		items, err := rows(ctx, a.DB, `SELECT l.id,l.action,l.created_at,
			CASE WHEN u.id IS NULL THEN NULL ELSE jsonb_build_object('userId',u.id,'username',u.username,'displayName',u.display_name) END AS actor
			FROM canvas_access_logs l LEFT JOIN users u ON u.id=l.actor_id WHERE l.project_id=$1 ORDER BY l.created_at DESC,l.id DESC LIMIT $2 OFFSET $3`, id, limit, offset)
		return gin.H{"items": items, "total": total}, err
	}))
}
