package platform

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

// shareTargetAccess 校验当前用户是分享目标的所有者；分享链接只能由资源所有者创建或撤销。
func shareTargetAccess(ctx context.Context, q querier, kind, targetID, userID string) error {
	var exists bool
	var err error
	if kind == "asset" {
		err = q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM assets WHERE id=$1 AND owner_id=$2)", targetID, userID).Scan(&exists)
	} else {
		err = q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM canvas_projects WHERE id=$1 AND user_id=$2)", targetID, userID).Scan(&exists)
	}
	if err != nil {
		return err
	}
	if !exists {
		return notFound
	}
	return nil
}

// shareLifetimeDays 是分享链接的有效期；到期后重新生成即可，避免 token 泄露后永久可读。
const shareLifetimeDays = 90

func shareView(row Row) Row {
	return Row{"token": row["token"], "url": "/s/" + str(row["token"]), "createdAt": row["createdAt"], "expiresAt": row["expiresAt"], "createdBy": row["createdBy"]}
}

func currentShare(ctx context.Context, q querier, kind, id string) (Row, error) {
	share, err := one(ctx, q, `SELECT s.token,s.created_at,s.expires_at,
		jsonb_build_object('userId',u.id,'username',u.username,'displayName',u.display_name) AS created_by
		FROM share_links s JOIN users u ON u.id=s.user_id
		WHERE s.kind=$1 AND s.target_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now()`, kind, id)
	if errors.Is(err, notFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return shareView(share), nil
}

func lockShareOwner(ctx context.Context, tx pgx.Tx, kind, id, userID string) error {
	if kind == "canvas" {
		return lockCanvasOwner(ctx, tx, id, userID)
	}
	_, err := one(ctx, tx, "SELECT id FROM assets WHERE id=$1 AND owner_id=$2 FOR UPDATE", id, userID)
	return err
}

// 同一资源的创建、重置和撤销串行执行，避免并发创建撞上有效链接唯一索引。
func (a *App) createShare(ctx context.Context, kind, id, userID string, reset bool) (Row, error) {
	var share Row
	err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		if err := lockShareOwner(ctx, tx, kind, id, userID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "UPDATE share_links SET revoked_at=now() WHERE kind=$1 AND target_id=$2 AND revoked_at IS NULL AND ($3 OR expires_at<=now())", kind, id, reset); err != nil {
			return err
		}
		var err error
		share, err = currentShare(ctx, tx, kind, id)
		if err != nil || share != nil {
			return err
		}
		token, tokenErr := randomToken()
		if tokenErr != nil {
			return tokenErr
		}
		if _, err = tx.Exec(ctx, "INSERT INTO share_links(user_id,kind,target_id,token,expires_at) VALUES($1,$2,$3,$4,now()+make_interval(days=>$5::int))", userID, kind, id, token, shareLifetimeDays); err != nil {
			return err
		}
		share, err = currentShare(ctx, tx, kind, id)
		if err != nil {
			return err
		}
		if kind == "canvas" {
			action := "share_created"
			if reset {
				action = "share_reset"
			}
			return recordCanvasAccess(ctx, tx, id, userID, action)
		}
		return nil
	})
	return share, err
}

// publicCanvasSnapshot 只移除画布助手私有对话，不改动源画布的快照。
func publicCanvasSnapshot(value any) map[string]any {
	snapshot := object(value)
	result := make(map[string]any, len(snapshot))
	for key, field := range snapshot {
		if key != "chatSessions" && key != "activeChatId" {
			result[key] = field
		}
	}
	return result
}

// activeShare 按 token 查找未撤销的分享；token 即访问凭证，不在接口里额外校验登录态。
func (a *App) activeShare(ctx context.Context, token string) (Row, error) {
	if len(token) < 32 || len(token) > 128 {
		return nil, problem(404, "share_not_found", "分享链接不存在或已撤销")
	}
	share, err := one(ctx, a.DB, "SELECT kind,target_id FROM share_links WHERE token=$1 AND revoked_at IS NULL AND expires_at>now()", token)
	if err != nil {
		return nil, problem(404, "share_not_found", "分享链接不存在或已撤销")
	}
	return share, nil
}

// shareRoutes 挂载画布与素材的只读分享链接管理接口（登录态，所有者限定）。
func (a *App) shareRoutes(api *gin.RouterGroup) {
	for _, item := range []struct {
		path, kind string
	}{
		{"canvas-projects", "canvas"},
		{"assets", "asset"},
	} {
		path, kind := item.path, item.kind
		api.GET("/"+path+"/:id/share", respond(func(c *gin.Context) (any, error) {
			id, err := idParam(c, "id")
			if err != nil {
				return nil, err
			}
			ctx := c.Request.Context()
			if err := shareTargetAccess(ctx, a.DB, kind, id, currentUser(c).ID); err != nil {
				return nil, err
			}
			share, err := currentShare(ctx, a.DB, kind, id)
			return gin.H{"share": share}, err
		}))
		api.POST("/"+path+"/:id/share", a.rateLimit("share-create", 30, time.Minute), respond(func(c *gin.Context) (any, error) {
			id, err := idParam(c, "id")
			if err != nil {
				return nil, err
			}
			share, err := a.createShare(c.Request.Context(), kind, id, currentUser(c).ID, false)
			return gin.H{"share": share}, err
		}))
		api.POST("/"+path+"/:id/share/reset", a.rateLimit("share-create", 30, time.Minute), respond(func(c *gin.Context) (any, error) {
			id, err := idParam(c, "id")
			if err != nil {
				return nil, err
			}
			share, err := a.createShare(c.Request.Context(), kind, id, currentUser(c).ID, true)
			return gin.H{"share": share}, err
		}))
		api.DELETE("/"+path+"/:id/share", respond(func(c *gin.Context) (any, error) {
			id, err := idParam(c, "id")
			if err != nil {
				return nil, err
			}
			ctx := c.Request.Context()
			userID := currentUser(c).ID
			err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
				if err := lockShareOwner(ctx, tx, kind, id, userID); err != nil {
					return err
				}
				result, err := tx.Exec(ctx, "UPDATE share_links SET revoked_at=now() WHERE kind=$1 AND target_id=$2 AND revoked_at IS NULL", kind, id)
				if err != nil {
					return err
				}
				if kind == "canvas" && result.RowsAffected() > 0 {
					return recordCanvasAccess(ctx, tx, id, userID, "share_revoked")
				}
				return nil
			})
			return nil, err
		}))
	}
}

// publicShareRoutes 挂载无需登录的只读分享访问：仅暴露被显式分享的对象与其引用的媒体文件。
func (a *App) publicShareRoutes(r *gin.Engine) {
	r.GET("/api/shared/:token", respond(func(c *gin.Context) (any, error) {
		ctx := c.Request.Context()
		if err := a.rate(c, "shared:ip:"+hash(a.clientIP(c)), 120, time.Minute); err != nil {
			return nil, err
		}
		share, err := a.activeShare(ctx, c.Param("token"))
		if err != nil {
			return nil, err
		}
		if str(share["kind"]) == "canvas" {
			project, err := one(ctx, a.DB, `SELECT p.id,p.title,p.snapshot,p.created_at,p.updated_at,
				(SELECT display_name FROM users WHERE id=p.user_id) AS owner_name
				FROM canvas_projects p WHERE p.id=$1 AND EXISTS(SELECT 1 FROM share_links s
					WHERE s.kind='canvas' AND s.target_id=p.id AND s.token=$2 AND s.revoked_at IS NULL AND s.expires_at>now())`, share["targetId"], c.Param("token"))
			if err != nil {
				return nil, err
			}
			project["snapshot"] = publicCanvasSnapshot(project["snapshot"])
			if err = recordCanvasAccess(ctx, a.DB, str(share["targetId"]), "", "public_view"); err != nil {
				return nil, err
			}
			return gin.H{"kind": "canvas", "canvas": project}, nil
		}
		asset, err := one(ctx, a.DB, `SELECT s.id,s.type,s.title,s.content,s.media_id,s.metadata,s.created_at,
			(SELECT display_name FROM users WHERE id=s.owner_id) AS owner_name
			FROM assets s WHERE s.id=$1 AND EXISTS(SELECT 1 FROM share_links l
				WHERE l.kind='asset' AND l.target_id=s.id AND l.token=$2 AND l.revoked_at IS NULL AND l.expires_at>now())`, share["targetId"], c.Param("token"))
		if err != nil {
			return nil, err
		}
		return gin.H{"kind": "asset", "asset": asset}, nil
	}))
	r.GET("/api/shared/:token/media/:mediaId", func(c *gin.Context) {
		ctx := c.Request.Context()
		if err := a.rate(c, "shared-media:ip:"+hash(a.clientIP(c)), 600, time.Minute); err != nil {
			fail(c, err)
			return
		}
		mediaID, err := idParam(c, "mediaId")
		if err != nil {
			fail(c, err)
			return
		}
		share, err := a.activeShare(ctx, c.Param("token"))
		if err != nil {
			fail(c, err)
			return
		}
		var allowed bool
		if str(share["kind"]) == "canvas" {
			var project Row
			project, err = one(ctx, a.DB, "SELECT snapshot FROM canvas_projects WHERE id=$1", share["targetId"])
			if err == nil && slices.Contains(extractMediaIDs(publicCanvasSnapshot(project["snapshot"])), mediaID) {
				// 快照内容不作为唯一授权依据：必须同时命中服务端写入的引用表，
				// 防止客户端夹带字段绕过。
				err = a.DB.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM media_references WHERE owner_kind='canvas' AND owner_id=$1 AND media_id=$2)", share["targetId"], mediaID).Scan(&allowed)
			}
		} else {
			err = a.DB.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM assets a JOIN media_references mr ON mr.owner_kind='asset' AND mr.owner_id=a.id AND mr.media_id=a.media_id WHERE a.id=$1 AND a.media_id=$2)", share["targetId"], mediaID).Scan(&allowed)
		}
		if err != nil {
			fail(c, err)
			return
		}
		if !allowed {
			fail(c, problem(404, "media_not_found", "文件不存在或未被分享"))
			return
		}
		row, err := one(ctx, a.DB, `SELECT m.* FROM media_objects m WHERE m.id=$1 AND m.status='ready'
			AND EXISTS(SELECT 1 FROM share_links s WHERE s.token=$2 AND s.revoked_at IS NULL AND s.expires_at>now()
				AND EXISTS(SELECT 1 FROM media_references mr WHERE mr.owner_kind=s.kind AND mr.owner_id=s.target_id AND mr.media_id=m.id))`, mediaID, c.Param("token"))
		if err != nil {
			fail(c, err)
			return
		}
		a.serveMedia(c, row)
	})
}
