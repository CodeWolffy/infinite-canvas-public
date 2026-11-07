package platform

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

const canvasPresenceLifetime = 90 * time.Second

// canvasProjectDetail 统一详情和实时读取；个人状态只在当前用户的 HTTP 响应中合并。
func canvasProjectDetail(ctx context.Context, q querier, id, userID string, includePersonal bool) (Row, error) {
	if err := projectAccess(ctx, q, id, userID); err != nil {
		return nil, err
	}
	project, err := one(ctx, q, `SELECT `+canvasSummary+`,snapshot,workspace_id,
		(SELECT name FROM workspaces WHERE id=p.workspace_id) AS workspace_name,
		`+projectRoleExpression("p", "$2")+` AS access_role,p.user_id=$2 AS can_manage_sharing,
		(p.user_id=$2 OR EXISTS(SELECT 1 FROM workspaces w WHERE w.id=p.workspace_id AND w.owner_id=$2)) AS can_delete
		FROM canvas_projects p WHERE p.id=$1 AND (`+projectRoleExpression("p", "$2")+`)<>''`, id, userID)
	if err != nil {
		return nil, err
	}
	snapshot := sharedCanvasSnapshot(object(project["snapshot"]))
	project["snapshot"] = snapshot
	if includePersonal {
		state, err := one(ctx, q, "SELECT viewport,chat_sessions,active_chat_id FROM canvas_user_views WHERE project_id=$1 AND user_id=$2", id, userID)
		if err != nil && !errors.Is(err, notFound) {
			return nil, err
		}
		snapshot["viewport"] = map[string]any{"x": 0.0, "y": 0.0, "k": 1.0}
		snapshot["chatSessions"] = []any{}
		snapshot["activeChatId"] = nil
		if state != nil {
			snapshot["viewport"], snapshot["chatSessions"], snapshot["activeChatId"] = state["viewport"], state["chatSessions"], state["activeChatId"]
		}
	}
	return project, nil
}

// 调用方持有画布行锁；个人数据和其媒体引用在同一事务中写入，viewer 也可保存自己的视口。
func saveCanvasPersonalState(ctx context.Context, tx pgx.Tx, id, userID string, snapshot, viewport map[string]any) error {
	if err := projectAccess(ctx, tx, id, userID); err != nil {
		return err
	}
	personal := map[string]any{}
	for _, key := range []string{"viewport", "chatSessions", "activeChatId"} {
		if value, ok := snapshot[key]; ok {
			personal[key] = value
		}
	}
	if viewport != nil {
		personal["viewport"] = viewport
	}
	if len(personal) == 0 {
		return nil
	}
	validation := map[string]any{"nodes": []any{}, "connections": []any{}}
	for key, value := range personal {
		validation[key] = value
	}
	if err := validateCanvasSnapshot(validation); err != nil {
		return err
	}
	state, err := one(ctx, tx, "SELECT viewport,chat_sessions,active_chat_id FROM canvas_user_views WHERE project_id=$1 AND user_id=$2 FOR UPDATE", id, userID)
	if err != nil && !errors.Is(err, notFound) {
		return err
	}
	if state == nil {
		state = Row{"viewport": map[string]any{"x": 0.0, "y": 0.0, "k": 1.0}, "chatSessions": []any{}, "activeChatId": nil}
	}
	chatSessions, hasChatSessions := personal["chatSessions"]
	chatChanged := hasChatSessions && !bytes.Equal(jsonBytes(chatSessions), jsonBytes(state["chatSessions"]))
	for key, value := range personal {
		state[key] = value
	}
	var stateID string
	err = tx.QueryRow(ctx, `INSERT INTO canvas_user_views(project_id,user_id,viewport,chat_sessions,active_chat_id) VALUES($1,$2,$3,$4,$5)
		ON CONFLICT(project_id,user_id) DO UPDATE SET viewport=excluded.viewport,chat_sessions=excluded.chat_sessions,active_chat_id=excluded.active_chat_id
		RETURNING id`, id, userID, jsonBytes(state["viewport"]), jsonBytes(state["chatSessions"]), state["activeChatId"]).Scan(&stateID)
	if err != nil {
		return err
	}
	if !chatChanged {
		return nil
	}
	return syncMediaRefs(ctx, tx, "canvas_personal", stateID, userID, extractMediaIDs(state["chatSessions"]))
}

func saveCanvasPersonalHistory(ctx context.Context, tx pgx.Tx, projectID, historyID, userID string) error {
	if err := projectAccess(ctx, tx, projectID, userID); err != nil {
		return err
	}
	state, err := one(ctx, tx, `INSERT INTO canvas_history_personal(history_id,user_id,snapshot)
		SELECT $2,user_id,jsonb_build_object('viewport',viewport,'chatSessions',chat_sessions,'activeChatId',active_chat_id)
		FROM canvas_user_views WHERE project_id=$1 AND user_id=$3
		AND EXISTS(SELECT 1 FROM canvas_project_history WHERE id=$2 AND project_id=$1)
		RETURNING snapshot`, projectID, historyID, userID)
	if errors.Is(err, notFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return syncMediaRefs(ctx, tx, "canvas_history_personal", historyID, userID, extractMediaIDs(state["snapshot"]))
}

func restoreCanvasPersonalHistory(ctx context.Context, tx pgx.Tx, projectID, historyID, userID string) error {
	if err := projectAccess(ctx, tx, projectID, userID); err != nil {
		return err
	}
	history, err := one(ctx, tx, `SELECT hp.snapshot FROM canvas_history_personal hp
		JOIN canvas_project_history h ON h.id=hp.history_id WHERE hp.history_id=$1 AND hp.user_id=$2 AND h.project_id=$3`, historyID, userID, projectID)
	if errors.Is(err, notFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return saveCanvasPersonalState(ctx, tx, projectID, userID, object(history["snapshot"]), nil)
}

func (a *App) publishCanvasChange(ctx context.Context, id string) {
	a.publishBatchEvent(ctx, "canvas:"+id)
}

func canvasOnlineMembers(ctx context.Context, q querier, id, userID string) ([]Row, error) {
	if err := projectAccess(ctx, q, id, userID); err != nil {
		return nil, err
	}
	return rows(ctx, q, `SELECT DISTINCT u.id AS user_id,u.username,u.display_name FROM canvas_presence cp
		JOIN users u ON u.id=cp.user_id JOIN canvas_projects p ON p.id=cp.project_id
		WHERE cp.project_id=$1 AND cp.expires_at>now() AND u.status='active'
		AND (`+projectRoleExpression("p", "u.id")+`)<>'' ORDER BY u.username,u.id`, id)
}

func (a *App) canvasRealtimeRoutes(api *gin.RouterGroup) {
	api.GET("/canvas-projects/:id/events", a.canvasEvents)
	api.POST("/canvas-projects/:id/presence", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			ClientID string `json:"clientId"`
		}](c)
		if err != nil {
			return nil, err
		}
		if !validID(input.ClientID) {
			return nil, problem(400, "invalid_client", "画布连接编号不正确")
		}
		ctx, userID := c.Request.Context(), currentUser(c).ID
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if err := projectAccess(ctx, tx, id, userID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "DELETE FROM canvas_presence WHERE project_id=$1 AND expires_at<=now()", id); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, `INSERT INTO canvas_presence(project_id,user_id,client_id,expires_at) VALUES($1,$2,$3,now()+$4*interval '1 second')
				ON CONFLICT(project_id,user_id,client_id) DO UPDATE SET expires_at=excluded.expires_at`, id, userID, input.ClientID, int(canvasPresenceLifetime/time.Second))
			return err
		})
		if err == nil {
			a.publishCanvasChange(ctx, id)
		}
		return nil, err
	}))
	api.DELETE("/canvas-projects/:id/presence/:clientId", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		clientID, err := idParam(c, "clientId")
		if err != nil {
			return nil, err
		}
		ctx, userID := c.Request.Context(), currentUser(c).ID
		if err := projectAccess(ctx, a.DB, id, userID); err != nil {
			return nil, err
		}
		_, err = a.DB.Exec(ctx, "DELETE FROM canvas_presence WHERE project_id=$1 AND user_id=$2 AND client_id=$3", id, userID, clientID)
		if err == nil {
			a.publishCanvasChange(ctx, id)
		}
		return nil, err
	}))
}

func (a *App) canvasEvents(c *gin.Context) {
	id, err := idParam(c, "id")
	if err != nil {
		fail(c, err)
		return
	}
	ctx, userID := c.Request.Context(), currentUser(c).ID
	if err := projectAccess(ctx, a.DB, id, userID); err != nil {
		fail(c, err)
		return
	}
	if !a.acquireStream(userID) {
		fail(c, problem(429, "too_many_streams", "同时打开的实时连接过多，请稍后重试"))
		return
	}
	defer a.releaseStream(userID)
	key := "canvas:" + id
	changed := a.addSink(key)
	defer a.removeSink(key, changed)
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-store")
	c.Header("X-Accel-Buffering", "no")
	controller := http.NewResponseController(c.Writer)
	send := func(event string, value any) bool {
		_ = controller.SetWriteDeadline(time.Now().Add(streamWriteTimeout))
		c.SSEvent(event, value)
		return controller.Flush() == nil
	}
	ticker := time.NewTicker(queuePoll)
	defer ticker.Stop()
	var lastCheck time.Time
	var lastProject, lastMembers []byte
	refresh := true
	for {
		if time.Since(lastCheck) >= textSessionInterval {
			lastCheck, refresh = time.Now(), true
		}
		if refresh {
			refresh = false
			if _, err := a.loadUser(c); err != nil {
				send("expired", gin.H{})
				return
			}
			project, err := canvasProjectDetail(ctx, a.DB, id, userID, false)
			if err != nil {
				send("unavailable", gin.H{})
				return
			}
			members, err := canvasOnlineMembers(ctx, a.DB, id, userID)
			if err != nil {
				send("unavailable", gin.H{})
				return
			}
			if err := projectAccess(ctx, a.DB, id, userID); err != nil {
				send("unavailable", gin.H{})
				return
			}
			if raw := jsonBytes(project); !bytes.Equal(lastProject, raw) {
				if !send("snapshot", gin.H{"project": project}) {
					return
				}
				lastProject = raw
			}
			if raw := jsonBytes(members); !bytes.Equal(lastMembers, raw) {
				if err := projectAccess(ctx, a.DB, id, userID); err != nil {
					send("unavailable", gin.H{})
					return
				}
				if !send("presence", gin.H{"members": members}) {
					return
				}
				lastMembers = raw
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-a.shutdown:
			return
		case <-changed:
			refresh = true
		case <-ticker.C:
			_ = controller.SetWriteDeadline(time.Now().Add(streamWriteTimeout))
			if _, err := c.Writer.Write([]byte(": ping\n\n")); err != nil || controller.Flush() != nil {
				return
			}
		}
	}
}
