package platform

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const canvasSummary = "id,title,revision,created_at,updated_at,coalesce(jsonb_array_length(snapshot->'nodes'),0) AS node_count,coalesce(jsonb_array_length(snapshot->'connections'),0) AS connection_count"

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
// canvasViewport 只接受 x/y/k：视口保存不经过媒体引用同步，必须白名单，
// 否则任意字段都能落进快照，而公开分享按快照内容授权媒体。
func canvasViewport(value map[string]any) error {
	if len(value) != 3 {
		return problem(400, "invalid_viewport", "画布视口只允许 x、y、k")
	}
	for _, key := range []string{"x", "y", "k"} {
		if _, ok := value[key].(float64); !ok {
			return problem(400, "invalid_viewport", "画布视口格式不正确")
		}
	}
	return nil
}
// projectRole 返回用户对画布的有效角色：项目所有者 > 工作区成员角色，无权限返回空串。
func projectRole(ctx context.Context, q querier, id, userID string) (string, error) {
	var role string
	err := q.QueryRow(ctx, `SELECT coalesce(CASE WHEN p.user_id=$2 THEN 'owner' END,wm.role,'')
		FROM canvas_projects p LEFT JOIN workspace_members wm ON wm.workspace_id=p.workspace_id AND wm.user_id=$2
		WHERE p.id=$1`, id, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return role, err
}
func projectAccess(ctx context.Context, q querier, id, userID string) error {
	if id == "" {
		return nil
	}
	role, err := projectRole(ctx, q, id, userID)
	if err != nil {
		return err
	}
	if role == "" {
		return notFound
	}
	return nil
}
// projectWriteAccess 只允许所有者与工作区编辑者写画布；viewer 角色只读。
func projectWriteAccess(ctx context.Context, q querier, id, userID string) error {
	role, err := projectRole(ctx, q, id, userID)
	if err != nil {
		return err
	}
	if role != "owner" && role != "editor" {
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
		items, err := rows(c.Request.Context(), a.DB, "SELECT id,name,display_name,capability,sort_order,description,price_micros,input_price_per_million,cached_price_per_million,output_price_per_million,price_per_second,coalesce(config->'reasoningEfforts','[]'::jsonb) AS reasoning_efforts,coalesce(config->'imageInput','false'::jsonb) AS image_input FROM models m WHERE m.status='published' AND m.deleted_at IS NULL AND (m.capability<>'audio' OR m.price_per_second IS NULL) AND EXISTS(SELECT 1 FROM users u LEFT JOIN user_groups g ON g.id=u.group_id WHERE u.id=$1 AND (g.model_ids IS NULL OR m.id=ANY(g.model_ids))) AND EXISTS(SELECT 1 FROM available_model_channels v WHERE v.model_id=m.id) ORDER BY sort_order,created_at", u.ID)
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
	api.PUT("/preferences", a.rateLimit("preferences-write", 60, time.Minute), respond(func(c *gin.Context) (any, error) {
		input, err := body[map[string]any](c)
		if err != nil {
			return nil, err
		}
		var raw []byte
		err = a.DB.QueryRow(c.Request.Context(), "INSERT INTO user_preferences(user_id,preferences) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET preferences=user_preferences.preferences || excluded.preferences,updated_at=now() RETURNING preferences", currentUser(c).ID, jsonBytes(input)).Scan(&raw)
		return gin.H{"preferences": json.RawMessage(raw)}, err
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
	// accessColumns 追加当前用户对每行的有效角色与删除权限，前端据此控制只读/删除入口。
	accessColumns := `,workspace_id,(SELECT name FROM workspaces WHERE id=canvas_projects.workspace_id) AS workspace_name,
		CASE WHEN user_id=$1 THEN 'owner' ELSE coalesce((SELECT wm.role FROM workspace_members wm WHERE wm.workspace_id=canvas_projects.workspace_id AND wm.user_id=$1),'') END AS access_role,
		(user_id=$1 OR EXISTS(SELECT 1 FROM workspaces w WHERE w.id=canvas_projects.workspace_id AND w.owner_id=$1)) AS can_delete`
	visible := "user_id=$1 OR EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=canvas_projects.workspace_id AND wm.user_id=$1)"
	api.GET("/canvas-projects", respond(func(c *gin.Context) (any, error) {
		limit, offset := paginationWith(c, 200, 500)
		ctx, userID := c.Request.Context(), currentUser(c).ID
		total, err := one(ctx, a.DB, "SELECT count(*)::int AS total FROM canvas_projects WHERE "+visible, userID)
		if err != nil {
			return nil, err
		}
		projects, err := rows(ctx, a.DB, "SELECT "+canvasSummary+accessColumns+" FROM canvas_projects WHERE "+visible+" ORDER BY updated_at DESC LIMIT $2 OFFSET $3", userID, limit, offset)
		return gin.H{"projects": projects, "total": integer(total["total"])}, err
	}))
	api.GET("/canvas-projects/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		project, err := one(c.Request.Context(), a.DB, "SELECT "+canvasSummary+",snapshot"+accessColumns+" FROM canvas_projects WHERE id=$2 AND ("+visible+")", currentUser(c).ID, id)
		return gin.H{"project": project}, err
	}))
	saveProject := respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			Title            *string        `json:"title"`
			Snapshot         map[string]any `json:"snapshot"`
			Viewport         map[string]any `json:"viewport"`
			WorkspaceID      *string        `json:"workspaceId"`
			ExpectedRevision *int64         `json:"expectedRevision"`
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
		if input.Viewport != nil {
			if err = canvasViewport(input.Viewport); err != nil {
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
				var workspace any
				if input.WorkspaceID != nil && strings.TrimSpace(*input.WorkspaceID) != "" {
					target := strings.TrimSpace(*input.WorkspaceID)
					if !validID(target) {
						return problem(400, "invalid_workspace", "工作区编号不正确")
					}
					role, err := workspaceRole(ctx, tx, target, userID)
					if err != nil {
						return err
					}
					if role != "owner" && role != "editor" {
						return problem(403, "forbidden", "需要工作区编辑权限才能在其中创建画布")
					}
					workspace = target
				}
				if _, err := tx.Exec(ctx, "INSERT INTO canvas_projects(id,user_id,title,snapshot,workspace_id) VALUES($1,$2,$3,$4,$5)", id, userID, *input.Title, jsonBytes(input.Snapshot), workspace); err != nil {
					return err
				}
			} else {
				oldProject, err := one(ctx, tx, "SELECT id,user_id,revision FROM canvas_projects WHERE id=$1 FOR UPDATE", id)
				if err != nil {
					return err
				}
				if err := projectWriteAccess(ctx, tx, id, userID); err != nil {
					return err
				}
				if input.Title != nil || input.Snapshot != nil || input.Viewport != nil {
					if input.ExpectedRevision == nil || *input.ExpectedRevision < 0 {
						return problem(400, "invalid_revision", "保存画布内容必须提供有效的 expectedRevision")
					}
				}
				if input.ExpectedRevision != nil && *input.ExpectedRevision != integer(oldProject["revision"]) {
					return problem(409, "canvas_revision_conflict", "画布已被其他操作修改，本地编辑已保留；请先核对远端内容并明确处理冲突，普通重试不会覆盖远端修改")
				}
				if input.WorkspaceID != nil {
					if str(oldProject["userId"]) != userID && currentUser(c).Role != "admin" {
						return problem(403, "forbidden", "仅画布所有者可以调整所属工作区")
					}
					target := strings.TrimSpace(*input.WorkspaceID)
					var workspace any
					if target != "" {
						if !validID(target) {
							return problem(400, "invalid_workspace", "工作区编号不正确")
						}
						role, err := workspaceRole(ctx, tx, target, userID)
						if err != nil {
							return err
						}
						if role != "owner" && role != "editor" {
							return problem(403, "forbidden", "需要工作区编辑权限才能移入画布")
						}
						workspace = target
					}
					if _, err := tx.Exec(ctx, "UPDATE canvas_projects SET workspace_id=$2,updated_at=now() WHERE id=$1", id, workspace); err != nil {
						return err
					}
				}
				if input.Snapshot != nil {
					// 先用走索引的时间窗口判断，避免每次保存都整份比较 JSONB。
					var recent bool
					if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM canvas_project_history WHERE project_id=$1 AND note IS NULL AND created_at>now()-interval '5 minutes')", id).Scan(&recent); err != nil {
						return err
					}
					if !recent {
						history, err := rows(ctx, tx, "INSERT INTO canvas_project_history(project_id,user_id,title,snapshot) SELECT id,user_id,title,snapshot FROM canvas_projects WHERE id=$1 AND (snapshot-'viewport') IS DISTINCT FROM ($2::jsonb-'viewport') RETURNING id", id, jsonBytes(input.Snapshot))
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
			}
			if input.Snapshot != nil {
				if err := syncMediaRefs(ctx, tx, "canvas", id, userID, extractMediaIDs(input.Snapshot)); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, "UPDATE canvas_projects SET snapshot=$2,updated_at=now() WHERE id=$1", id, jsonBytes(input.Snapshot)); err != nil {
					return err
				}
			} else if input.Viewport != nil {
				// 平移和缩放只改视口，原地替换这一个字段，不重写整份快照。
				if _, err := tx.Exec(ctx, "UPDATE canvas_projects SET snapshot=jsonb_set(snapshot,'{viewport}',$2::jsonb,true),updated_at=now() WHERE id=$1", id, jsonBytes(input.Viewport)); err != nil {
					return err
				}
			}
			if input.Title != nil {
				if _, err := tx.Exec(ctx, "UPDATE canvas_projects SET title=$2,updated_at=now() WHERE id=$1", id, strings.TrimSpace(*input.Title)); err != nil {
					return err
				}
			}
			if !create && (input.Title != nil || input.Snapshot != nil || input.Viewport != nil || input.WorkspaceID != nil) {
				if _, err := tx.Exec(ctx, "UPDATE canvas_projects SET revision=revision+1 WHERE id=$1", id); err != nil {
					return err
				}
			}
			if input.Snapshot != nil {
				if err := trimCanvasHistory(ctx, tx, id); err != nil {
					return err
				}
			}
			var err error
			// 只有创建时客户端需要快照本身；更新只回传统计信息，避免每次保存都读回整份快照。
			columns := canvasSummary + ",workspace_id,(SELECT name FROM workspaces WHERE id=canvas_projects.workspace_id) AS workspace_name"
			if create {
				columns += ",snapshot"
			}
			saved, err = one(ctx, tx, "SELECT "+columns+" FROM canvas_projects WHERE id=$1", id)
			return err
		})
		if err != nil {
			return nil, err
		}
		return gin.H{"project": saved}, nil
	})
	api.POST("/canvas-projects", a.rateLimit("canvas-create", 30, time.Minute), saveProject)
	// 内容保存 1 秒防抖、视口保存 3 秒防抖，单标签页理论上限约 80 次/分钟；放宽到 300 给多标签页留余量。
	api.PUT("/canvas-projects/:id", a.rateLimit("canvas-save", 300, time.Minute), saveProject)
	api.GET("/canvas-projects/:id/history", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		if err = projectAccess(c.Request.Context(), a.DB, id, currentUser(c).ID); err != nil {
			return nil, err
		}
		items, err := rows(c.Request.Context(), a.DB, "SELECT id,title,note,created_at,coalesce(jsonb_array_length(snapshot->'nodes'),0) AS node_count,coalesce(jsonb_array_length(snapshot->'connections'),0) AS connection_count FROM canvas_project_history WHERE project_id=$1 ORDER BY created_at DESC,id DESC", id)
		return gin.H{"history": items}, err
	}))
	api.POST("/canvas-projects/:id/history", a.rateLimit("canvas-history-write", 30, time.Minute), respond(func(c *gin.Context) (any, error) {
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
			if err := projectWriteAccess(ctx, tx, id, userID); err != nil {
				return err
			}
			if _, err := one(ctx, tx, "SELECT id FROM canvas_projects WHERE id=$1 FOR UPDATE", id); err != nil {
				return err
			}
			var err error
			saved, err = one(ctx, tx, "INSERT INTO canvas_project_history(project_id,user_id,title,snapshot,note) SELECT id,user_id,title,snapshot,$2 FROM canvas_projects WHERE id=$1 RETURNING id,title,note,created_at,jsonb_array_length(snapshot->'nodes') AS node_count,jsonb_array_length(snapshot->'connections') AS connection_count", id, input.Note)
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
	api.POST("/canvas-projects/:id/history/:historyId/restore", a.rateLimit("canvas-history-write", 30, time.Minute), respond(func(c *gin.Context) (any, error) {
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
			if err := projectWriteAccess(ctx, tx, id, u.ID); err != nil {
				return err
			}
			if _, err := one(ctx, tx, "SELECT id FROM canvas_projects WHERE id=$1 FOR UPDATE", id); err != nil {
				return err
			}
			history, err := one(ctx, tx, "SELECT * FROM canvas_project_history WHERE id=$1 AND project_id=$2", historyID, id)
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
			if _, err = tx.Exec(ctx, "UPDATE canvas_projects SET title=$2,snapshot=$3,revision=revision+1,updated_at=now() WHERE id=$1", id, history["title"], jsonBytes(history["snapshot"])); err != nil {
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
			if _, err := one(ctx, tx, "SELECT id FROM canvas_projects WHERE id=$1 AND (user_id=$2 OR EXISTS(SELECT 1 FROM workspaces w WHERE w.id=canvas_projects.workspace_id AND w.owner_id=$2)) FOR UPDATE", id, currentUser(c).ID); err != nil {
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
	Scope       string         `json:"scope" binding:"omitempty,oneof=private public"`
	Type        string         `json:"type" binding:"omitempty,oneof=image text video audio"`
	Title       string         `json:"title" binding:"omitempty,max=200"`
	Content     *string        `json:"content"`
	MediaID     *string        `json:"mediaId"`
	Metadata    map[string]any `json:"metadata"`
	WorkspaceID *string        `json:"workspaceId"`
}

func (a *App) assetRoutes(api *gin.RouterGroup) {
	api.GET("/assets", respond(func(c *gin.Context) (any, error) {
		limit, offset := pagination(c)
		scope := c.DefaultQuery("scope", "all")
		u := currentUser(c)
		// 素材页改为服务端分页后，关键词与类型筛选也必须在服务端执行。
		// 工作区共享素材只对成员可见，统一并入 all 视图，不混入 private/public 筛选。
		where, args := "((scope='public' AND $2<>'private') OR (owner_id=$1 AND scope='private' AND $2<>'public') OR ($2='all' AND owner_id<>$1 AND EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=assets.workspace_id AND wm.user_id=$1)))", []any{u.ID, scope}
		if kind := c.Query("kind"); kind != "" {
			args = append(args, kind)
			where += " AND type=$" + str(len(args))
		}
		if keyword := strings.TrimSpace(c.Query("keyword")); keyword != "" {
			args = append(args, "%"+keyword+"%")
			placeholder := "$" + str(len(args))
			where += " AND (title ILIKE " + placeholder + " OR coalesce(content,'') ILIKE " + placeholder + ")"
		}
		ctx := c.Request.Context()
		total, err := one(ctx, a.DB, "SELECT count(*)::int AS total FROM assets WHERE "+where, args...)
		if err != nil {
			return nil, err
		}
		query := `SELECT *,CASE WHEN owner_id=$1 THEN 'owner' ELSE coalesce((SELECT wm.role FROM workspace_members wm WHERE wm.workspace_id=assets.workspace_id AND wm.user_id=$1),'') END AS access_role,
			(SELECT name FROM workspaces WHERE id=assets.workspace_id) AS workspace_name FROM assets WHERE ` + where + " ORDER BY updated_at DESC,id DESC LIMIT $" + str(len(args)+1) + " OFFSET $" + str(len(args)+2)
		items, err := rows(ctx, a.DB, query, append(args, limit, offset)...)
		return gin.H{"assets": items, "total": integer(total["total"])}, err
	}))
	api.GET("/assets/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		row, err := one(c.Request.Context(), a.DB, `SELECT *,CASE WHEN owner_id=$2 THEN 'owner' ELSE coalesce((SELECT wm.role FROM workspace_members wm WHERE wm.workspace_id=assets.workspace_id AND wm.user_id=$2),'') END AS access_role,
			(SELECT name FROM workspaces WHERE id=assets.workspace_id) AS workspace_name
			FROM assets WHERE id=$1 AND (owner_id=$2 OR scope='public' OR EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=assets.workspace_id AND wm.user_id=$2))`, id, currentUser(c).ID)
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
			var workspaceID any
			if !create {
				old, err := one(ctx, tx, "SELECT * FROM assets WHERE id=$1 AND (owner_id=$2 OR ($3 AND scope='public') OR EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=assets.workspace_id AND wm.user_id=$2 AND wm.role IN('owner','editor'))) FOR UPDATE", id, u.ID, u.Role == "admin")
				if err != nil {
					return err
				}
				owner = str(old["ownerId"])
				workspaceID = old["workspaceId"]
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
				// 工作区协作者只能改标题、正文与元数据：替换范围、类型或关联文件
				// 会把内容换到他人的公开分享页，只有素材所有者（或管理员）可以改。
				if owner != u.ID && u.Role != "admin" {
					input.Scope, input.Type = str(old["scope"]), str(old["type"])
					input.MediaID = nil
					if old["mediaId"] != nil {
						mediaID := str(old["mediaId"])
						input.MediaID = &mediaID
					}
				}
			}
			// 调整素材所属工作区只允许素材所有者/管理员执行；目标工作区要求编辑者及以上角色。
			if input.WorkspaceID != nil {
				if owner != u.ID && u.Role != "admin" {
					return problem(403, "forbidden", "仅素材所有者可以调整所属工作区")
				}
				target := strings.TrimSpace(*input.WorkspaceID)
				workspaceID = nil
				if target != "" {
					if !validID(target) {
						return problem(400, "invalid_workspace", "工作区编号不正确")
					}
					role, err := workspaceRole(ctx, tx, target, u.ID)
					if err != nil {
						return err
					}
					if role != "owner" && role != "editor" {
						return problem(403, "forbidden", "需要工作区编辑权限才能移入素材")
					}
					workspaceID = target
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
			if _, err := tx.Exec(ctx, "INSERT INTO assets(id,owner_id,scope,type,title,content,media_id,metadata,workspace_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,type=excluded.type,title=excluded.title,content=excluded.content,media_id=excluded.media_id,metadata=excluded.metadata,workspace_id=excluded.workspace_id,updated_at=now()", id, owner, input.Scope, input.Type, input.Title, input.Content, input.MediaID, jsonBytes(input.Metadata), workspaceID); err != nil {
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
	api.POST("/assets", a.rateLimit("assets-write", 60, time.Minute), save)
	api.PUT("/assets/:id", a.rateLimit("assets-write", 60, time.Minute), save)
	api.DELETE("/assets/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		u := currentUser(c)
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			result, err := tx.Exec(ctx, "DELETE FROM assets WHERE id=$1 AND (owner_id=$2 OR ($3 AND scope='public') OR EXISTS(SELECT 1 FROM workspaces w WHERE w.id=assets.workspace_id AND w.owner_id=$2))", id, u.ID, u.Role == "admin")
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
