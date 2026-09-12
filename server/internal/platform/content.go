package platform

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const canvasSummary = "id,title,created_at,updated_at,coalesce(jsonb_array_length(snapshot->'nodes'),0) AS node_count,coalesce(jsonb_array_length(snapshot->'connections'),0) AS connection_count"

func canvasSnapshot(value any) error {
	m, ok := value.(map[string]any)
	if !ok {
		return problem(400, "invalid_snapshot", "画布快照格式不正确")
	}
	for _, key := range []string{"nodes", "connections"} {
		if _, ok := m[key].([]any); !ok {
			return problem(400, "invalid_snapshot", "画布节点或连接格式不正确")
		}
	}
	return nil
}
func projectAccess(ctx context.Context, q querier, id, userID string) error {
	if id == "" {
		return nil
	}
	var exists bool
	if err := q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM canvas_projects WHERE id=$1 AND user_id=$2)", id, userID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return notFound
	}
	return nil
}
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (a *App) contentRoutes(api *gin.RouterGroup) {
	a.mediaRoutes(api)
	api.GET("/models", respond(func(c *gin.Context) (any, error) {
		u := currentUser(c)
		items, err := rows(c.Request.Context(), a.DB, "SELECT id,name,display_name,capability,sort_order,description,price_micros,input_price_per_million,cached_price_per_million,output_price_per_million,price_per_second,coalesce(config->'reasoningEfforts','[]'::jsonb) AS reasoning_efforts FROM models m WHERE m.status='published' AND m.deleted_at IS NULL AND EXISTS(SELECT 1 FROM users u LEFT JOIN user_groups g ON g.id=u.group_id WHERE u.id=$1 AND (g.model_ids IS NULL OR m.id=ANY(g.model_ids))) AND EXISTS(SELECT 1 FROM model_channels b JOIN channels c ON c.id=b.channel_id WHERE b.model_id=m.id AND b.enabled AND c.status='active' AND c.deleted_at IS NULL) ORDER BY sort_order,created_at", u.ID)
		if err != nil {
			return nil, err
		}
		discount, err := a.groupDiscount(c.Request.Context(), a.DB, &u)
		if err != nil {
			return nil, err
		}
		for _, row := range items {
			pricing, err := pricingSnapshot(row, discount, nil, 0)
			if err != nil {
				return nil, err
			}
			for _, field := range []string{"inputPricePerMillion", "cachedPricePerMillion", "outputPricePerMillion", "pricePerSecond"} {
				if pricing[field] != nil {
					row[field] = modelPrice(integer(pricing[field]))
				}
			}
			row["price"] = modelPrice(integer(pricing["unitPriceMicros"]))
			row["pricePerImage"] = row["price"]
			row["groupDiscount"] = discount.String()
			delete(row, "priceMicros")
		}
		return gin.H{"models": items}, err
	}))
	api.GET("/preferences", respond(func(c *gin.Context) (any, error) {
		var raw []byte
		err := a.DB.QueryRow(c.Request.Context(), "SELECT preferences FROM user_preferences WHERE user_id=$1", currentUser(c).ID).Scan(&raw)
		if errors.Is(err, pgx.ErrNoRows) {
			raw = []byte("{}")
			err = nil
		}
		return gin.H{"preferences": json.RawMessage(raw)}, err
	}))
	api.PUT("/preferences", respond(func(c *gin.Context) (any, error) {
		input, err := body[map[string]any](c)
		if err != nil {
			return nil, err
		}
		_, err = a.DB.Exec(c.Request.Context(), "INSERT INTO user_preferences(user_id,preferences) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET preferences=excluded.preferences,updated_at=now()", currentUser(c).ID, jsonBytes(input))
		return gin.H{"preferences": input}, err
	}))
	api.GET("/announcement", respond(func(c *gin.Context) (any, error) {
		var raw []byte
		err := a.DB.QueryRow(c.Request.Context(), "SELECT value FROM app_settings WHERE key='announcement'").Scan(&raw)
		if errors.Is(err, pgx.ErrNoRows) {
			raw = []byte(`{"title":"","content":"","entries":[]}`)
			err = nil
		}
		return gin.H{"announcement": json.RawMessage(raw)}, err
	}))
	api.GET("/canvas-projects", respond(func(c *gin.Context) (any, error) {
		projects, err := rows(c.Request.Context(), a.DB, "SELECT "+canvasSummary+" FROM canvas_projects WHERE user_id=$1 ORDER BY updated_at DESC", currentUser(c).ID)
		return gin.H{"projects": projects}, err
	}))
	api.GET("/canvas-projects/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		project, err := one(c.Request.Context(), a.DB, "SELECT "+canvasSummary+",snapshot FROM canvas_projects WHERE id=$1 AND user_id=$2", id, currentUser(c).ID)
		return gin.H{"project": project}, err
	}))
	saveProject := respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			Title    *string        `json:"title"`
			Snapshot map[string]any `json:"snapshot"`
		}](c)
		if err != nil {
			return nil, err
		}
		if input.Title != nil && (strings.TrimSpace(*input.Title) == "" || len([]rune(*input.Title)) > 200) {
			return nil, problem(400, "invalid_title", "请输入 1–200 字的画布标题")
		}
		if input.Snapshot != nil {
			if err = canvasSnapshot(input.Snapshot); err != nil {
				return nil, err
			}
		}
		ctx := c.Request.Context()
		userID := currentUser(c).ID
		id := c.Param("id")
		create := id == ""
		if create {
			id = uuid.NewString()
			if input.Title == nil || input.Snapshot == nil {
				return nil, problem(400, "invalid_request", "画布标题和快照必填")
			}
		} else if !validID(id) {
			return nil, problem(400, "invalid_id", "画布编号不正确")
		}
		var saved Row
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if create {
				if _, err := tx.Exec(ctx, "INSERT INTO canvas_projects(id,user_id,title,snapshot) VALUES($1,$2,$3,$4)", id, userID, *input.Title, jsonBytes(input.Snapshot)); err != nil {
					return err
				}
			} else {
				if _, err := one(ctx, tx, "SELECT id FROM canvas_projects WHERE id=$1 AND user_id=$2 FOR UPDATE", id, userID); err != nil {
					return err
				}
				if input.Snapshot != nil {
					history, err := rows(ctx, tx, "INSERT INTO canvas_project_history(project_id,user_id,title,snapshot) SELECT id,user_id,title,snapshot FROM canvas_projects WHERE id=$1 AND (snapshot-'viewport') IS DISTINCT FROM ($2::jsonb-'viewport') AND NOT EXISTS(SELECT 1 FROM canvas_project_history WHERE project_id=$1 AND note IS NULL AND created_at>now()-interval '5 minutes') RETURNING id", id, jsonBytes(input.Snapshot))
					if err != nil {
						return err
					}
					for _, h := range history {
						if _, err = tx.Exec(ctx, "INSERT INTO media_references(owner_kind,owner_id,user_id,media_id) SELECT 'history',$1,user_id,media_id FROM media_references WHERE owner_kind='canvas' AND owner_id=$2", h["id"], id); err != nil {
							return err
						}
					}
				}
			}
			if input.Snapshot != nil {
				if err := syncMediaRefs(ctx, tx, "canvas", id, userID, extractMediaIDs(input.Snapshot)); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, "UPDATE canvas_projects SET snapshot=$2,updated_at=now() WHERE id=$1", id, jsonBytes(input.Snapshot)); err != nil {
					return err
				}
			}
			if input.Title != nil {
				if _, err := tx.Exec(ctx, "UPDATE canvas_projects SET title=$2,updated_at=now() WHERE id=$1", id, strings.TrimSpace(*input.Title)); err != nil {
					return err
				}
			}
			if err := trimCanvasHistory(ctx, tx, id); err != nil {
				return err
			}
			var err error
			saved, err = one(ctx, tx, "SELECT "+canvasSummary+",snapshot FROM canvas_projects WHERE id=$1", id)
			return err
		})
		if err != nil {
			return nil, err
		}
		return gin.H{"project": saved}, nil
	})
	api.POST("/canvas-projects", saveProject)
	api.PUT("/canvas-projects/:id", saveProject)
	api.GET("/canvas-projects/:id/history", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		if err = projectAccess(c.Request.Context(), a.DB, id, currentUser(c).ID); err != nil {
			return nil, err
		}
		items, err := rows(c.Request.Context(), a.DB, "SELECT id,title,note,created_at,coalesce(jsonb_array_length(snapshot->'nodes'),0) AS node_count,coalesce(jsonb_array_length(snapshot->'connections'),0) AS connection_count FROM canvas_project_history WHERE project_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC", id, currentUser(c).ID)
		return gin.H{"history": items}, err
	}))
	api.POST("/canvas-projects/:id/history", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			Note string `json:"note" binding:"max=200"`
		}](c)
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		userID := currentUser(c).ID
		var saved Row
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if _, err := one(ctx, tx, "SELECT id FROM canvas_projects WHERE id=$1 AND user_id=$2 FOR UPDATE", id, userID); err != nil {
				return err
			}
			var err error
			saved, err = one(ctx, tx, "INSERT INTO canvas_project_history(project_id,user_id,title,snapshot,note) SELECT id,user_id,title,snapshot,$3 FROM canvas_projects WHERE id=$1 AND user_id=$2 RETURNING id,title,note,created_at,jsonb_array_length(snapshot->'nodes') AS node_count,jsonb_array_length(snapshot->'connections') AS connection_count", id, userID, input.Note)
			if err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "INSERT INTO media_references(owner_kind,owner_id,user_id,media_id) SELECT 'history',$1,user_id,media_id FROM media_references WHERE owner_kind='canvas' AND owner_id=$2", saved["id"], id); err != nil {
				return err
			}
			return trimCanvasHistory(ctx, tx, id)
		})
		return gin.H{"history": saved}, err
	}))
	api.POST("/canvas-projects/:id/history/:historyId/restore", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		historyID, err := idParam(c, "historyId")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		u := currentUser(c)
		var saved Row
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if _, err := one(ctx, tx, "SELECT id FROM canvas_projects WHERE id=$1 AND user_id=$2 FOR UPDATE", id, u.ID); err != nil {
				return err
			}
			history, err := one(ctx, tx, "SELECT * FROM canvas_project_history WHERE id=$1 AND project_id=$2 AND user_id=$3", historyID, id, u.ID)
			if err != nil {
				return err
			}
			backup, err := one(ctx, tx, "INSERT INTO canvas_project_history(project_id,user_id,title,snapshot,note) SELECT id,user_id,title,snapshot,'恢复前备份' FROM canvas_projects WHERE id=$1 RETURNING id", id)
			if err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "INSERT INTO media_references(owner_kind,owner_id,user_id,media_id) SELECT 'history',$1,user_id,media_id FROM media_references WHERE owner_kind='canvas' AND owner_id=$2", backup["id"], id); err != nil {
				return err
			}
			if err = syncMediaRefs(ctx, tx, "canvas", id, u.ID, extractMediaIDs(history["snapshot"])); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "UPDATE canvas_projects SET title=$2,snapshot=$3,updated_at=now() WHERE id=$1", id, history["title"], jsonBytes(history["snapshot"])); err != nil {
				return err
			}
			if err = trimCanvasHistory(ctx, tx, id); err != nil {
				return err
			}
			saved, err = one(ctx, tx, "SELECT "+canvasSummary+",snapshot FROM canvas_projects WHERE id=$1", id)
			return err
		})
		return gin.H{"project": saved}, err
	}))
	api.DELETE("/canvas-projects/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if _, err := one(ctx, tx, "SELECT id FROM canvas_projects WHERE id=$1 AND user_id=$2 FOR UPDATE", id, currentUser(c).ID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "DELETE FROM media_references WHERE (owner_kind='canvas' AND owner_id=$1) OR (owner_kind='history' AND owner_id IN(SELECT id FROM canvas_project_history WHERE project_id=$1))", id); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, "DELETE FROM canvas_projects WHERE id=$1", id)
			return err
		})
		return nil, err
	}))
	a.assetRoutes(api)
}
func trimCanvasHistory(ctx context.Context, tx pgx.Tx, id string) error {
	expired, err := rows(ctx, tx, "SELECT id FROM canvas_project_history WHERE project_id=$1 ORDER BY created_at DESC,id DESC OFFSET 20", id)
	if err != nil {
		return err
	}
	for _, row := range expired {
		if _, err = tx.Exec(ctx, "DELETE FROM media_references WHERE owner_kind='history' AND owner_id=$1", row["id"]); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "DELETE FROM canvas_project_history WHERE id=$1", row["id"]); err != nil {
			return err
		}
	}
	return nil
}

type assetInput struct {
	Scope    string         `json:"scope" binding:"omitempty,oneof=private public"`
	Type     string         `json:"type" binding:"omitempty,oneof=image text video audio"`
	Title    string         `json:"title" binding:"omitempty,max=200"`
	Content  *string        `json:"content"`
	MediaID  *string        `json:"mediaId"`
	Metadata map[string]any `json:"metadata"`
}

func (a *App) assetRoutes(api *gin.RouterGroup) {
	api.GET("/assets", respond(func(c *gin.Context) (any, error) {
		limit, offset := pagination(c)
		scope := c.DefaultQuery("scope", "all")
		u := currentUser(c)
		items, err := rows(c.Request.Context(), a.DB, "SELECT * FROM assets WHERE ((scope='public' AND $2<>'private') OR (owner_id=$1 AND scope='private' AND $2<>'public')) ORDER BY updated_at DESC,id DESC LIMIT $3 OFFSET $4", u.ID, scope, limit, offset)
		return gin.H{"assets": items}, err
	}))
	api.GET("/assets/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		row, err := one(c.Request.Context(), a.DB, "SELECT * FROM assets WHERE id=$1 AND (owner_id=$2 OR scope='public')", id, currentUser(c).ID)
		return gin.H{"asset": row}, err
	}))
	save := respond(func(c *gin.Context) (any, error) {
		input, err := body[assetInput](c)
		if err != nil {
			return nil, err
		}
		id := c.Param("id")
		create := id == ""
		if create {
			id = uuid.NewString()
		} else if !validID(id) {
			return nil, problem(400, "invalid_id", "素材编号不正确")
		}
		ctx := c.Request.Context()
		u := currentUser(c)
		var saved Row
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			owner := u.ID
			if !create {
				old, err := one(ctx, tx, "SELECT * FROM assets WHERE id=$1 AND (owner_id=$2 OR ($3 AND scope='public')) FOR UPDATE", id, u.ID, u.Role == "admin")
				if err != nil {
					return err
				}
				owner = str(old["ownerId"])
				if input.Scope == "" {
					input.Scope = str(old["scope"])
				}
				if input.Type == "" {
					input.Type = str(old["type"])
				}
				if input.Title == "" {
					input.Title = str(old["title"])
				}
				if input.Content == nil && old["content"] != nil {
					content := str(old["content"])
					input.Content = &content
				}
				if input.MediaID == nil && old["mediaId"] != nil {
					mediaID := str(old["mediaId"])
					input.MediaID = &mediaID
				}
				if input.Metadata == nil {
					input.Metadata, _ = old["metadata"].(map[string]any)
				}
			}
			if input.Scope == "" {
				input.Scope = "private"
			}
			if input.Scope == "public" && u.Role != "admin" {
				return problem(403, "forbidden", "仅管理员可以发布公共素材")
			}
			if strings.TrimSpace(input.Title) == "" || input.Type == "" {
				return problem(400, "invalid_asset", "请输入素材名称与类型")
			}
			if input.Metadata == nil {
				input.Metadata = map[string]any{}
			}
			ids := []string{}
			if input.Type != "text" {
				if input.MediaID == nil || !validID(*input.MediaID) {
					return problem(400, "invalid_media", "请选择已上传的素材文件")
				}
				media, err := readableMedia(ctx, tx, *input.MediaID, u.ID, u.Role == "admin")
				if err != nil {
					return err
				}
				if !strings.HasPrefix(str(media["mimeType"]), input.Type+"/") && !(input.Type == "audio" && str(media["mimeType"]) == "application/ogg") {
					return problem(400, "invalid_media", "文件与素材类型不匹配")
				}
				ids = append(ids, *input.MediaID)
			} else {
				input.MediaID = nil
			}
			if _, err := tx.Exec(ctx, "INSERT INTO assets(id,owner_id,scope,type,title,content,media_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,type=excluded.type,title=excluded.title,content=excluded.content,media_id=excluded.media_id,metadata=excluded.metadata,updated_at=now()", id, owner, input.Scope, input.Type, input.Title, input.Content, input.MediaID, jsonBytes(input.Metadata)); err != nil {
				return err
			}
			if err := syncMediaRefs(ctx, tx, "asset", id, owner, ids); err != nil {
				return err
			}
			var err error
			saved, err = one(ctx, tx, "SELECT * FROM assets WHERE id=$1", id)
			return err
		})
		return gin.H{"asset": saved}, err
	})
	api.POST("/assets", save)
	api.PUT("/assets/:id", save)
	api.DELETE("/assets/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		u := currentUser(c)
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			result, err := tx.Exec(ctx, "DELETE FROM assets WHERE id=$1 AND (owner_id=$2 OR ($3 AND scope='public'))", id, u.ID, u.Role == "admin")
			if err != nil {
				return err
			}
			if result.RowsAffected() == 0 {
				return notFound
			}
			_, err = tx.Exec(ctx, "DELETE FROM media_references WHERE owner_kind='asset' AND owner_id=$1", id)
			return err
		})
		return nil, err
	}))
}
