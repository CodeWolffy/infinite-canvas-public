package platform

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

// workspaceRole 返回用户在工作区内的角色（owner/editor/viewer），非成员返回空串。
func workspaceRole(ctx context.Context, q querier, workspaceID, userID string) (string, error) {
	var role string
	err := q.QueryRow(ctx, "SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", workspaceID, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return role, err
}

// workspaceOwner 校验当前用户是否为工作区所有者；成员管理与工作区设置只对 owner 开放。
func (a *App) workspaceOwner(ctx context.Context, workspaceID, userID string) (Row, error) {
	workspace, err := one(ctx, a.DB, "SELECT id,name,owner_id,created_at FROM workspaces WHERE id=$1", workspaceID)
	if err != nil {
		return nil, err
	}
	if str(workspace["ownerId"]) != userID {
		return nil, problem(403, "forbidden", "仅工作区所有者可以执行此操作")
	}
	return workspace, nil
}

func (a *App) workspaceRoutes(api *gin.RouterGroup) {
	api.GET("/workspaces", respond(func(c *gin.Context) (any, error) {
		items, err := rows(c.Request.Context(), a.DB, `SELECT w.id,w.name,w.owner_id,wm.role AS my_role,w.created_at,
			(SELECT count(*)::int FROM workspace_members m WHERE m.workspace_id=w.id) AS member_count,
			(SELECT count(*)::int FROM canvas_projects p WHERE p.workspace_id=w.id) AS project_count,
			(SELECT count(*)::int FROM assets s WHERE s.workspace_id=w.id) AS asset_count
			FROM workspaces w JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=$1
			ORDER BY w.created_at DESC`, currentUser(c).ID)
		return gin.H{"workspaces": items}, err
	}))
	api.POST("/workspaces", a.rateLimit("workspace-create", 20, time.Hour), respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			Name string `json:"name" binding:"required,max=80"`
		}](c)
		if err != nil {
			return nil, err
		}
		input.Name = strings.TrimSpace(input.Name)
		if input.Name == "" {
			return nil, problem(400, "invalid_name", "请输入工作区名称")
		}
		ctx := c.Request.Context()
		u := currentUser(c)
		var workspace Row
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			var err error
			workspace, err = one(ctx, tx, "INSERT INTO workspaces(name,owner_id) VALUES($1,$2) RETURNING id,name,owner_id,created_at", input.Name, u.ID)
			if err != nil {
				return err
			}
			_, err = tx.Exec(ctx, "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", workspace["id"], u.ID)
			return err
		})
		if err == nil {
			workspace["myRole"] = "owner"
		}
		return gin.H{"workspace": workspace}, err
	}))
	api.GET("/workspaces/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		u := currentUser(c)
		role, err := workspaceRole(ctx, a.DB, id, u.ID)
		if err != nil {
			return nil, err
		}
		if role == "" {
			return nil, notFound
		}
		workspace, err := one(ctx, a.DB, "SELECT id,name,owner_id,created_at FROM workspaces WHERE id=$1", id)
		if err != nil {
			return nil, err
		}
		workspace["myRole"] = role
		members, err := rows(ctx, a.DB, "SELECT m.user_id,m.role,m.created_at,u.username,u.display_name FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY m.created_at,m.user_id", id)
		if err != nil {
			return nil, err
		}
		projects, err := rows(ctx, a.DB, "SELECT "+canvasSummary+",(SELECT display_name FROM users WHERE id=user_id) AS owner_name FROM canvas_projects WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT 200", id)
		if err != nil {
			return nil, err
		}
		assets, err := rows(ctx, a.DB, "SELECT id,owner_id,type,title,content,media_id,metadata,created_at,updated_at,(SELECT display_name FROM users WHERE id=owner_id) AS owner_name FROM assets WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT 200", id)
		if err != nil {
			return nil, err
		}
		return gin.H{"workspace": workspace, "members": members, "projects": projects, "assets": assets}, nil
	}))
	api.PUT("/workspaces/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			Name string `json:"name" binding:"required,max=80"`
		}](c)
		if err != nil {
			return nil, err
		}
		input.Name = strings.TrimSpace(input.Name)
		if input.Name == "" {
			return nil, problem(400, "invalid_name", "请输入工作区名称")
		}
		ctx := c.Request.Context()
		if _, err = a.workspaceOwner(ctx, id, currentUser(c).ID); err != nil {
			return nil, err
		}
		workspace, err := one(ctx, a.DB, "UPDATE workspaces SET name=$2,updated_at=now() WHERE id=$1 RETURNING id,name,owner_id,created_at", id, input.Name)
		return gin.H{"workspace": workspace}, err
	}))
	api.DELETE("/workspaces/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		if _, err = a.workspaceOwner(ctx, id, currentUser(c).ID); err != nil {
			return nil, err
		}
		// 项目与素材的 workspace_id 走 ON DELETE SET NULL，成员行随工作区级联删除。
		_, err = a.DB.Exec(ctx, "DELETE FROM workspaces WHERE id=$1", id)
		return nil, err
	}))
	api.POST("/workspaces/:id/members", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			Username string `json:"username" binding:"required,max=64"`
			Role     string `json:"role" binding:"required,oneof=editor viewer"`
		}](c)
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		if _, err = a.workspaceOwner(ctx, id, currentUser(c).ID); err != nil {
			return nil, err
		}
		username := strings.ToLower(strings.TrimSpace(input.Username))
		target, err := one(ctx, a.DB, "SELECT id,status FROM users WHERE username=$1", username)
		if err != nil {
			return nil, problem(404, "user_not_found", "未找到该用户")
		}
		if str(target["status"]) != "active" {
			return nil, problem(400, "user_inactive", "该用户已被停用")
		}
		member, err := one(ctx, a.DB, `INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)
			ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role
			RETURNING user_id,role,created_at`, id, target["id"], input.Role)
		if err != nil {
			return nil, err
		}
		member["username"] = username
		name, err := one(ctx, a.DB, "SELECT display_name FROM users WHERE id=$1", target["id"])
		if err == nil {
			member["displayName"] = name["displayName"]
		}
		return gin.H{"member": member}, nil
	}))
	api.PATCH("/workspaces/:id/members/:userId", respond(func(c *gin.Context) (any, error) {
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
		ctx := c.Request.Context()
		if _, err = a.workspaceOwner(ctx, id, currentUser(c).ID); err != nil {
			return nil, err
		}
		// 所有者行不可降级，工作区必须始终保留一位 owner。
		member, err := one(ctx, a.DB, "UPDATE workspace_members SET role=$3 WHERE workspace_id=$1 AND user_id=$2 AND role<>'owner' RETURNING user_id,role,created_at", id, userID, input.Role)
		return gin.H{"member": member}, err
	}))
	api.DELETE("/workspaces/:id/members/:userId", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		userID, err := idParam(c, "userId")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		u := currentUser(c)
		// 所有者可以移除其他成员；普通成员只能自己退出，所有者行不可移除。
		if userID != u.ID {
			if _, err = a.workspaceOwner(ctx, id, u.ID); err != nil {
				return nil, err
			}
		}
		result, err := a.DB.Exec(ctx, "DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role<>'owner'", id, userID)
		if err != nil {
			return nil, err
		}
		if result.RowsAffected() == 0 {
			return nil, notFound
		}
		return nil, nil
	}))
}
