package platform

import (
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

const templateSummary = "id,title,description,created_at,updated_at,coalesce(jsonb_array_length(snapshot->'nodes'),0) AS node_count,coalesce(jsonb_array_length(snapshot->'connections'),0) AS connection_count"

// templateRoutes 挂载模板库接口：用户可浏览模板并一键创建画布；管理员负责维护模板内容。
func (a *App) templateRoutes(api *gin.RouterGroup, admin *gin.RouterGroup) {
	list := respond(func(c *gin.Context) (any, error) {
		items, err := rows(c.Request.Context(), a.DB, "SELECT "+templateSummary+" FROM canvas_templates ORDER BY created_at DESC,id LIMIT 200")
		return gin.H{"templates": items}, err
	})
	api.GET("/canvas-templates", list)
	admin.GET("/canvas-templates", list)

	api.POST("/canvas-templates/:id/use", a.rateLimit("template-use", 60, time.Minute), respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		u := currentUser(c)
		var project Row
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			tpl, err := one(ctx, tx, "SELECT title,snapshot FROM canvas_templates WHERE id=$1", id)
			if err != nil {
				return err
			}
			snapshot := object(tpl["snapshot"])
			if err := canvasSnapshot(snapshot); err != nil {
				return err
			}
			project, err = one(ctx, tx, "INSERT INTO canvas_projects(user_id,title,snapshot) VALUES($1,$2,$3) RETURNING "+canvasSummary+",snapshot", u.ID, str(tpl["title"]), jsonBytes(snapshot))
			if err != nil {
				return err
			}
			// 模板媒体对所有登录用户可见（见 mediaVisibility），引用关系按新画布重新登记。
			return syncMediaRefs(ctx, tx, "canvas", str(project["id"]), u.ID, extractMediaIDs(snapshot))
		})
		return gin.H{"project": project}, err
	}))

	admin.POST("/canvas-templates", a.rateLimit("template-write", 30, time.Minute), respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			Title       string `json:"title" binding:"required,max=200"`
			Description string `json:"description" binding:"max=500"`
			ProjectID   string `json:"projectId" binding:"required,uuid"`
		}](c)
		if err != nil {
			return nil, err
		}
		input.Title = strings.TrimSpace(input.Title)
		input.Description = strings.TrimSpace(input.Description)
		if input.Title == "" {
			return nil, problem(400, "invalid_title", "请输入模板名称")
		}
		ctx := c.Request.Context()
		u := currentUser(c)
		var tpl Row
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			source, err := one(ctx, tx, "SELECT snapshot FROM canvas_projects WHERE id=$1 AND user_id=$2", input.ProjectID, u.ID)
			if err != nil {
				return err
			}
			snapshot := publicCanvasSnapshot(source["snapshot"])
			tpl, err = one(ctx, tx, "INSERT INTO canvas_templates(title,description,snapshot,created_by) VALUES($1,$2,$3,$4) RETURNING "+templateSummary, input.Title, input.Description, jsonBytes(snapshot), u.ID)
			if err != nil {
				return err
			}
			return syncMediaRefs(ctx, tx, "template", str(tpl["id"]), u.ID, extractMediaIDs(snapshot))
		})
		return gin.H{"template": tpl}, err
	}))
	admin.PUT("/canvas-templates/:id", a.rateLimit("template-write", 30, time.Minute), respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			Title       string `json:"title" binding:"required,max=200"`
			Description string `json:"description" binding:"max=500"`
		}](c)
		if err != nil {
			return nil, err
		}
		input.Title = strings.TrimSpace(input.Title)
		if input.Title == "" {
			return nil, problem(400, "invalid_title", "请输入模板名称")
		}
		tpl, err := one(c.Request.Context(), a.DB, "UPDATE canvas_templates SET title=$2,description=$3,updated_at=now() WHERE id=$1 RETURNING "+templateSummary, id, input.Title, strings.TrimSpace(input.Description))
		return gin.H{"template": tpl}, err
	}))
	admin.DELETE("/canvas-templates/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, "DELETE FROM media_references WHERE owner_kind='template' AND owner_id=$1", id); err != nil {
				return err
			}
			result, err := tx.Exec(ctx, "DELETE FROM canvas_templates WHERE id=$1", id)
			if err != nil {
				return err
			}
			if result.RowsAffected() == 0 {
				return notFound
			}
			return nil
		})
		return nil, err
	}))
}
