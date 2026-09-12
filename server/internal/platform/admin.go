package platform

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/alexedwards/argon2id"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type modelInput struct {
	Name                  string         `json:"name" binding:"required,max=120"`
	DisplayName           string         `json:"displayName" binding:"required,max=120"`
	Capability            string         `json:"capability" binding:"required,oneof=image text video audio"`
	Status                string         `json:"status" binding:"required,oneof=draft published disabled"`
	SortOrder             int            `json:"sortOrder"`
	PricePerImage         any            `json:"pricePerImage"`
	Price                 string         `json:"price"`
	InputPricePerMillion  *string        `json:"inputPricePerMillion"`
	CachedPricePerMillion *string        `json:"cachedPricePerMillion"`
	OutputPricePerMillion *string        `json:"outputPricePerMillion"`
	PricePerSecond        *string        `json:"pricePerSecond"`
	Description           *string        `json:"description"`
	Config                map[string]any `json:"config"`
}

func publicModelRows(items []Row) []Row {
	for _, row := range items {
		row["price"] = money(integer(row["priceMicros"]))
		if row["inputPricePerMillion"] != nil {
			row["inputPricePerMillion"] = money(integer(row["inputPricePerMillion"]))
			row["outputPricePerMillion"] = money(integer(row["outputPricePerMillion"]))
			if row["cachedPricePerMillion"] != nil {
				row["cachedPricePerMillion"] = money(integer(row["cachedPricePerMillion"]))
			}
		}
		delete(row, "priceMicros")
		if row["pricePerSecond"] != nil {
			row["pricePerSecond"] = money(integer(row["pricePerSecond"]))
		}
	}
	return items
}
func publicChannel(row Row) Row {
	row["apiKeyConfigured"] = integer(row["keyCount"]) > 0
	return row
}

func validateChannelBinding(ctx context.Context, q querier, modelID, channelID string) error {
	row, err := one(ctx, q, "SELECT m.capability,c.protocol FROM models m JOIN channels c ON c.id=$2 WHERE m.id=$1 AND m.deleted_at IS NULL AND c.deleted_at IS NULL", modelID, channelID)
	if err != nil {
		return err
	}
	if row["protocol"] == "anthropic" && row["capability"] != "text" {
		return problem(400, "invalid_capability", "Claude Messages 渠道只能绑定文本模型")
	}
	return nil
}

func (a *App) adminRoutes(admin *gin.RouterGroup) {
	admin.GET("/users", respond(func(c *gin.Context) (any, error) {
		items, err := rows(c.Request.Context(), a.DB, "SELECT u.id,u.username,u.display_name,u.role,u.status,u.must_change_password,u.last_login_at,u.created_at,u.group_id,g.name AS group_name,w.balance_micros,w.frozen_micros FROM users u LEFT JOIN user_groups g ON g.id=u.group_id JOIN wallets w ON w.user_id=u.id ORDER BY u.created_at DESC")
		for _, row := range items {
			row["balance"] = money(integer(row["balanceMicros"]))
			row["frozen"] = money(integer(row["frozenMicros"]))
			delete(row, "balanceMicros")
			delete(row, "frozenMicros")
		}
		return gin.H{"users": items}, err
	}))
	admin.POST("/users", respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			Username          string `json:"username" binding:"required,max=64"`
			DisplayName       string `json:"displayName" binding:"required,max=80"`
			TemporaryPassword string `json:"temporaryPassword" binding:"required,min=10,max=128"`
			Role              string `json:"role" binding:"required,oneof=admin user"`
		}](c)
		if err != nil {
			return nil, err
		}
		input.Username = strings.ToLower(strings.TrimSpace(input.Username))
		if !usernamePattern.MatchString(input.Username) {
			return nil, problem(400, "invalid_username", "用户名格式不正确")
		}
		encoded, err := argon2id.CreateHash(input.TemporaryPassword, argon2id.DefaultParams)
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		var u User
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			var err error
			u, err = scanUser(tx.QueryRow(ctx, "INSERT INTO users(username,display_name,password_hash,role,must_change_password) VALUES($1,$2,$3,$4,true) RETURNING id,username,display_name,role,status,must_change_password,last_login_at,created_at,password_hash,NULL,NULL", input.Username, input.DisplayName, encoded, input.Role))
			if err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "INSERT INTO wallets(user_id) VALUES($1)", u.ID); err != nil {
				return err
			}
			return a.audit(ctx, tx, currentUser(c).ID, "user.create", u.ID, gin.H{"username": u.Username, "role": u.Role})
		})
		return gin.H{"user": u}, err
	}))
	for _, field := range []string{"status", "role"} {
		field := field
		admin.PATCH("/users/:id/"+field, respond(func(c *gin.Context) (any, error) {
			id, err := idParam(c, "id")
			if err != nil {
				return nil, err
			}
			input, err := body[map[string]string](c)
			if err != nil {
				return nil, err
			}
			next := input[field]
			if field == "status" && next != "active" && next != "disabled" || field == "role" && next != "admin" && next != "user" {
				return nil, problem(400, "invalid_request", "状态或角色不正确")
			}
			if id == currentUser(c).ID && (next == "disabled" || next == "user") {
				return nil, problem(409, "self_protected", "不能禁用自己或移除自己的管理员权限")
			}
			ctx := c.Request.Context()
			var u User
			err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
				if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended('admin-roles',0))"); err != nil {
					return err
				}
				old, err := scanUser(tx.QueryRow(ctx, "SELECT "+userColumns+" FROM users u LEFT JOIN user_groups g ON g.id=u.group_id WHERE u.id=$1 FOR UPDATE OF u", id))
				if err != nil {
					return err
				}
				if old.Role == "admin" && old.Status == "active" && (next == "disabled" || next == "user") {
					var count int
					if err = tx.QueryRow(ctx, "SELECT count(*) FROM users WHERE role='admin' AND status='active'").Scan(&count); err != nil {
						return err
					}
					if count <= 1 {
						return problem(409, "last_admin", "必须保留一位有效管理员")
					}
				}
				u, err = scanUser(tx.QueryRow(ctx, "UPDATE users SET "+field+"=$2,updated_at=now() WHERE id=$1 RETURNING id,username,display_name,role,status,must_change_password,last_login_at,created_at,password_hash,group_id,(SELECT name FROM user_groups g WHERE g.id=users.group_id) AS group_name", id, next))
				if err != nil {
					return err
				}
				if _, err = tx.Exec(ctx, "UPDATE sessions SET revoked_at=now() WHERE user_id=$1", id); err != nil {
					return err
				}
				return a.audit(ctx, tx, currentUser(c).ID, "user."+field, id, input)
			})
			return gin.H{"user": u}, err
		}))
	}
	admin.POST("/users/:id/reset-password", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			TemporaryPassword string `json:"temporaryPassword" binding:"required,min=10,max=128"`
		}](c)
		if err != nil {
			return nil, err
		}
		encoded, err := argon2id.CreateHash(input.TemporaryPassword, argon2id.DefaultParams)
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			result, err := tx.Exec(ctx, "UPDATE users SET password_hash=$2,must_change_password=true,updated_at=now() WHERE id=$1", id, encoded)
			if err != nil {
				return err
			}
			if result.RowsAffected() != 1 {
				return notFound
			}
			if _, err = tx.Exec(ctx, "UPDATE sessions SET revoked_at=now() WHERE user_id=$1", id); err != nil {
				return err
			}
			if err = a.audit(ctx, tx, currentUser(c).ID, "user.password-reset", id, gin.H{}); err != nil {
				return err
			}
			return a.notifySecurity(ctx, tx, id, "password-reset:"+id+":"+fmt.Sprint(time.Now().UnixNano()), "管理员已重置你的密码", "请使用新的临时密码登录并立即修改。")
		})
		if err != nil {
			return nil, err
		}
		user, err := scanUser(a.DB.QueryRow(ctx, "SELECT "+userColumns+" FROM users u LEFT JOIN user_groups g ON g.id=u.group_id WHERE u.id=$1", id))
		return gin.H{"user": user}, err
	}))
	admin.GET("/models", respond(func(c *gin.Context) (any, error) {
		items, err := rows(c.Request.Context(), a.DB, "SELECT * FROM models WHERE deleted_at IS NULL ORDER BY sort_order,created_at DESC")
		return gin.H{"models": publicModelRows(items)}, err
	}))
	saveModel := respond(func(c *gin.Context) (any, error) {
		input, err := body[modelInput](c)
		if err != nil {
			return nil, err
		}
		id := c.Param("id")
		create := id == ""
		if create {
			id = uuid.NewString()
		} else if !validID(id) {
			return nil, problem(400, "invalid_id", "模型编号不正确")
		}
		price := input.Price
		if price == "" {
			price = str(input.PricePerImage)
		}
		if price == "" {
			price = "0"
		}
		micros, err := amountUnits(price, moneyScale)
		if err != nil {
			return nil, err
		}
		if micros < 0 {
			return nil, problem(400, "invalid_price", "模型价格不能为负数")
		}
		// token 计价仅对文本模型开放，单价为每百万 token 的人民币金额；缓存命中单价可省略，默认按输入单价。
		var inputPrice, cachedPrice, outputPrice any
		if input.InputPricePerMillion != nil || input.OutputPricePerMillion != nil {
			if input.Capability != "text" {
				return nil, problem(400, "invalid_price", "token 单价仅支持文本模型")
			}
			if input.InputPricePerMillion == nil || input.OutputPricePerMillion == nil || str(*input.InputPricePerMillion) == "" || str(*input.OutputPricePerMillion) == "" {
				return nil, problem(400, "invalid_price", "请同时填写输入与输出 token 单价")
			}
			var inMicros, outMicros int64
			inMicros, err = amountUnits(str(*input.InputPricePerMillion), moneyScale)
			if err != nil {
				return nil, err
			}
			outMicros, err = amountUnits(str(*input.OutputPricePerMillion), moneyScale)
			if err != nil {
				return nil, err
			}
			if inMicros < 0 || outMicros < 0 {
				return nil, problem(400, "invalid_price", "token 单价不能为负数")
			}
			inputPrice, outputPrice = inMicros, outMicros
			if input.CachedPricePerMillion != nil && str(*input.CachedPricePerMillion) != "" {
				var cachedMicros int64
				cachedMicros, err = amountUnits(str(*input.CachedPricePerMillion), moneyScale)
				if err != nil {
					return nil, err
				}
				if cachedMicros < 0 {
					return nil, problem(400, "invalid_price", "缓存 token 单价不能为负数")
				}
				cachedPrice = cachedMicros
			}
		}
		var perSecond any
		if input.PricePerSecond != nil {
			if input.Capability != "video" && input.Capability != "audio" {
				return nil, problem(400, "invalid_price", "按秒计价仅支持视频和音频模型")
			}
			n, err := amountUnits(*input.PricePerSecond, moneyScale)
			if err != nil {
				return nil, err
			}
			if n < 0 {
				return nil, problem(400, "invalid_price", "每秒价格不能为负数")
			}
			perSecond = n
		}
		if input.Config == nil {
			input.Config = map[string]any{}
		}
		ctx := c.Request.Context()
		var saved Row
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if !create {
				old, err := one(ctx, tx, "SELECT capability FROM models WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", id)
				if err != nil {
					return err
				}
				if old["capability"] != input.Capability {
					return problem(400, "capability_immutable", "模型类型修改请创建新模型")
				}
			}
			var err error
			saved, err = one(ctx, tx, "INSERT INTO models(id,name,display_name,capability,status,sort_order,price_per_image,price_micros,input_price_per_million,cached_price_per_million,output_price_per_million,description,config,price_per_second) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO UPDATE SET name=excluded.name,display_name=excluded.display_name,status=excluded.status,sort_order=excluded.sort_order,price_per_image=excluded.price_per_image,price_micros=excluded.price_micros,input_price_per_million=excluded.input_price_per_million,cached_price_per_million=excluded.cached_price_per_million,output_price_per_million=excluded.output_price_per_million,description=excluded.description,config=excluded.config,price_per_second=excluded.price_per_second,updated_at=now() RETURNING *", id, input.Name, input.DisplayName, input.Capability, input.Status, input.SortOrder, money(micros), micros, inputPrice, cachedPrice, outputPrice, input.Description, jsonBytes(input.Config), perSecond)
			if err != nil {
				return err
			}
			return a.audit(ctx, tx, currentUser(c).ID, "model.save", id, gin.H{"name": input.Name, "price": money(micros), "capability": input.Capability})
		})
		if err != nil {
			return nil, err
		}
		return gin.H{"model": publicModelRows([]Row{saved})[0]}, nil
	})
	admin.POST("/models", saveModel)
	admin.PUT("/models/:id", saveModel)
	admin.PATCH("/models/:id/status", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			Status string `json:"status" binding:"required,oneof=draft published disabled"`
		}](c)
		if err != nil {
			return nil, err
		}
		row, err := one(c.Request.Context(), a.DB, "UPDATE models SET status=$2,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING *", id, input.Status)
		if err != nil {
			return nil, err
		}
		return gin.H{"model": publicModelRows([]Row{row})[0]}, nil
	}))
	admin.DELETE("/models/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		_, err = a.DB.Exec(c.Request.Context(), "UPDATE models SET deleted_at=now(),status='disabled' WHERE id=$1", id)
		return nil, err
	}))
	admin.GET("/models/:id/channels", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		items, err := rows(c.Request.Context(), a.DB, "SELECT b.*,c.name AS channel_name,c.status AS channel_status FROM model_channels b JOIN channels c ON c.id=b.channel_id WHERE b.model_id=$1 AND c.deleted_at IS NULL ORDER BY b.priority DESC, b.created_at ASC", id)
		return gin.H{"bindings": items}, err
	}))
	admin.PUT("/models/:id/channels/:channelId", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		channelID, err := idParam(c, "channelId")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			ID            string `json:"id"`
			UpstreamModel string `json:"upstreamModel" binding:"required,max=160"`
			Priority      int    `json:"priority"`
			Weight        int    `json:"weight" binding:"required,min=1"`
			Enabled       bool   `json:"enabled"`
		}](c)
		if err != nil {
			return nil, err
		}
		if err = validateChannelBinding(c.Request.Context(), a.DB, id, channelID); err != nil {
			return nil, err
		}
		if strings.TrimSpace(input.ID) != "" {
			_, err = a.DB.Exec(c.Request.Context(), "UPDATE model_channels SET upstream_model=$3,priority=$4,weight=$5,enabled=$6,updated_at=now() WHERE id=$1 AND model_id=$2 AND channel_id=$7", input.ID, id, input.UpstreamModel, input.Priority, input.Weight, input.Enabled, channelID)
		} else {
			_, err = a.DB.Exec(c.Request.Context(), "INSERT INTO model_channels(model_id,channel_id,upstream_model,priority,weight,enabled) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(model_id,channel_id,upstream_model) DO UPDATE SET priority=excluded.priority,weight=excluded.weight,enabled=excluded.enabled,updated_at=now()", id, channelID, input.UpstreamModel, input.Priority, input.Weight, input.Enabled)
		}
		return gin.H{"saved": true}, err
	}))
	admin.POST("/models/:id/channels/:channelId/batch", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		channelID, err := idParam(c, "channelId")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			UpstreamModels []string `json:"upstreamModels" binding:"required,min=1"`
			Priority       int      `json:"priority"`
			Weight         int      `json:"weight" binding:"required,min=1"`
			Enabled        bool     `json:"enabled"`
		}](c)
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if err := validateChannelBinding(ctx, tx, id, channelID); err != nil {
				return err
			}
			for _, m := range input.UpstreamModels {
				m = strings.TrimSpace(m)
				if m == "" {
					continue
				}
				if len(m) > 160 {
					m = m[:160]
				}
				if _, err := tx.Exec(ctx, "INSERT INTO model_channels(model_id,channel_id,upstream_model,priority,weight,enabled) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(model_id,channel_id,upstream_model) DO UPDATE SET priority=excluded.priority,weight=excluded.weight,enabled=excluded.enabled,updated_at=now()", id, channelID, m, input.Priority, input.Weight, input.Enabled); err != nil {
					return err
				}
			}
			return nil
		})
		return gin.H{"saved": true}, err
	}))
	admin.DELETE("/models/:id/bindings/:bindingId", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		bindingID, err := idParam(c, "bindingId")
		if err != nil {
			return nil, err
		}
		_, err = a.DB.Exec(c.Request.Context(), "DELETE FROM model_channels WHERE model_id=$1 AND id=$2", id, bindingID)
		return nil, err
	}))
	admin.DELETE("/models/:id/channels/:channelId", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		channelID, err := idParam(c, "channelId")
		if err != nil {
			return nil, err
		}
		_, err = a.DB.Exec(c.Request.Context(), "DELETE FROM model_channels WHERE model_id=$1 AND channel_id=$2", id, channelID)
		return nil, err
	}))
	a.channelRoutes(admin)
	admin.PUT("/announcement", respond(func(c *gin.Context) (any, error) {
		input, err := body[map[string]any](c)
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			previous, err := one(ctx, tx, "SELECT value FROM app_settings WHERE key='announcement' FOR UPDATE")
			if err != nil && err != notFound {
				return err
			}
			publishedAt := ""
			if previous != nil {
				publishedAt = str(object(previous["value"])["publishedAt"])
			}
			if publishedAt == "" || input["forceAlert"] == true {
				publishedAt = time.Now().UTC().Format(time.RFC3339Nano)
			}
			delete(input, "forceAlert")
			input["publishedAt"] = publishedAt
			if _, err = tx.Exec(ctx, "INSERT INTO app_settings(key,value) VALUES('announcement',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()", jsonBytes(input)); err != nil {
				return err
			}
			return a.audit(ctx, tx, currentUser(c).ID, "announcement.publish", "announcement", gin.H{"publishedAt": publishedAt})
		})
		return gin.H{"announcement": input}, err
	}))
	admin.GET("/stats", respond(a.adminStats))
	admin.GET("/request-logs", respond(func(c *gin.Context) (any, error) { return a.listLogs(c, true) }))
	admin.DELETE("/request-logs", respond(func(c *gin.Context) (any, error) {
		result, err := a.DB.Exec(c.Request.Context(), "DELETE FROM request_logs WHERE status<>'running'")
		return gin.H{"deleted": result.RowsAffected()}, err
	}))
	admin.GET("/tasks", respond(func(c *gin.Context) (any, error) {
		limit, offset := pagination(c)
		items, err := rows(c.Request.Context(), a.DB, "SELECT t.id,t.batch_id,t.capability,t.status,t.attempt_count,t.max_attempts,t.model_display_name,t.error_code,t.error_message,t.queued_at,t.started_at,t.finished_at,u.username FROM generation_tasks t JOIN users u ON u.id=t.user_id WHERE ($1='' OR t.status=$1) AND ($2='' OR t.capability=$2) ORDER BY t.queued_at DESC LIMIT $3 OFFSET $4", c.Query("status"), c.Query("capability"), limit, offset)
		return gin.H{"tasks": items}, err
	}))
	admin.POST("/tasks/:id/cancel", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		err = a.cancelTask(c.Request.Context(), id, "", true)
		if err == nil {
			err = a.audit(c.Request.Context(), a.DB, currentUser(c).ID, "task.cancel", id, gin.H{})
		}
		return nil, err
	}))
}

func (a *App) channelRoutes(admin *gin.RouterGroup) {
	a.channelKeyRoutes(admin)
	admin.GET("/channels", respond(func(c *gin.Context) (any, error) {
		items, err := rows(c.Request.Context(), a.DB, `SELECT c.*,`+channelKeyCounts+`,row_to_json(latest) AS last_attempt,row_to_json(latency) AS latency FROM channels c
			LEFT JOIN LATERAL (SELECT status,duration_ms AS "durationMs",http_status AS "httpStatus",error_category AS "errorCategory",error_message AS "errorMessage",upstream_model AS "upstreamModel",started_at AS "startedAt",finished_at AS "finishedAt" FROM request_logs WHERE channel_id=c.id ORDER BY started_at DESC,id DESC LIMIT 1) latest ON true
			LEFT JOIN LATERAL (SELECT count(*) AS samples,percentile_cont(0.5) WITHIN GROUP(ORDER BY duration_ms) AS "p50Ms",percentile_cont(0.95) WITHIN GROUP(ORDER BY duration_ms) AS "p95Ms" FROM upstream_cost_entries WHERE channel_id=c.id AND status='succeeded' AND duration_ms IS NOT NULL) latency ON true
			WHERE c.deleted_at IS NULL ORDER BY c.created_at DESC`)
		for _, row := range items {
			publicChannel(row)
		}
		return gin.H{"channels": items}, err
	}))
	save := respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			Name            string `json:"name" binding:"required,max=120"`
			Protocol        string `json:"protocol" binding:"required,oneof=openai gemini anthropic"`
			BaseURL         string `json:"baseUrl" binding:"required"`
			APIKeys         []string `json:"apiKeys"`
			KeyStrategy     string `json:"keyStrategy" binding:"required,oneof=round_robin random"`
			TaskAdapter     string `json:"taskAdapter"`
			Status          string `json:"status" binding:"required,oneof=active disabled needs_attention"`
			TimeoutMS       int    `json:"timeoutMs" binding:"required,min=1000"`
			MaxConcurrency  int    `json:"maxConcurrency" binding:"required,min=1"`
			CooldownSeconds int    `json:"cooldownSeconds" binding:"min=0"`
		}](c)
		if err != nil {
			return nil, err
		}
		if err = validateTaskAdapter(input.TaskAdapter, input.Protocol); err != nil {
			return nil, err
		}
		u, err := url.Parse(input.BaseURL)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Scheme != "https" && u.Scheme != "http" {
			return nil, problem(400, "invalid_url", "请输入有效的渠道 Base URL")
		}
		if u.Scheme == "http" && !a.Config.AllowPrivateHosts {
			return nil, problem(400, "https_required", "公网渠道请使用 HTTPS；内网测试需显式开启对应配置")
		}
		id := c.Param("id")
		create := id == ""
		if create {
			id = uuid.NewString()
		} else if !validID(id) {
			return nil, problem(400, "invalid_id", "渠道编号不正确")
		}
		ctx := c.Request.Context()
		var saved Row
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if !create {
				if _, err := one(ctx, tx, "SELECT id FROM channels WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", id); err != nil {
					return err
				}
			}
			var err error
			if input.Protocol == "anthropic" {
				var incompatible bool
				if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM model_channels b JOIN models m ON m.id=b.model_id WHERE b.channel_id=$1 AND b.enabled AND m.deleted_at IS NULL AND m.capability<>'text')", id).Scan(&incompatible); err != nil {
					return err
				}
				if incompatible {
					return problem(400, "invalid_capability", "切换到 Claude Messages 前，请先解绑或停用非文本模型")
				}
			}
			_, err = tx.Exec(ctx, "INSERT INTO channels(id,name,protocol,base_url,status,timeout_ms,max_concurrency,cooldown_seconds,key_strategy,task_adapter) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET name=excluded.name,protocol=excluded.protocol,base_url=excluded.base_url,status=excluded.status,timeout_ms=excluded.timeout_ms,max_concurrency=excluded.max_concurrency,cooldown_seconds=excluded.cooldown_seconds,key_strategy=excluded.key_strategy,task_adapter=excluded.task_adapter,updated_at=now()", id, input.Name, input.Protocol, strings.TrimRight(input.BaseURL, "/"), input.Status, input.TimeoutMS, input.MaxConcurrency, input.CooldownSeconds, input.KeyStrategy, input.TaskAdapter)
			if err != nil {
				return err
			}
			if err = a.addChannelKeys(ctx, tx, id, input.APIKeys); err != nil {
				return err
			}
			saved, err = one(ctx, tx, "SELECT c.*,"+channelKeyCounts+" FROM channels c WHERE c.id=$1", id)
			if err != nil {
				return err
			}
			if input.Status == "active" && integer(saved["activeKeyCount"]) == 0 {
				return problem(400, "missing_key", "启用渠道前请配置至少一个可用 API Key")
			}
			return a.audit(ctx, tx, currentUser(c).ID, "channel.save", id, gin.H{"name": input.Name, "status": input.Status})
		})
		if err != nil {
			return nil, err
		}
		return gin.H{"channel": publicChannel(saved)}, nil
	})
	admin.POST("/channels", save)
	admin.PUT("/channels/:id", save)
	admin.DELETE("/channels/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, "DELETE FROM model_channels WHERE channel_id=$1", id); err != nil {
				return err
			}
			result, err := tx.Exec(ctx, "UPDATE channels SET status='disabled',deleted_at=now(),updated_at=now() WHERE id=$1 AND deleted_at IS NULL", id)
			if err != nil {
				return err
			}
			if result.RowsAffected() == 0 {
				return problem(404, "not_found", "渠道不存在")
			}
			return a.audit(ctx, tx, currentUser(c).ID, "channel.delete", id, nil)
		})
		return nil, err
	}))
	admin.POST("/channels/:id/models", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		row, err := one(c.Request.Context(), a.DB, "SELECT * FROM channels WHERE id=$1 AND deleted_at IS NULL", id)
		if err != nil {
			return nil, err
		}
		candidate, err := a.channelFromRow(row)
		if err != nil {
			return nil, err
		}
		if err = a.selectChannelKey(c.Request.Context(), &candidate, nil, true); err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), time.Duration(candidate.TimeoutMS)*time.Millisecond)
		defer cancel()
		names, err := a.channelModels(ctx, candidate)
		if err != nil {
			return nil, problem(502, "probe_failed", "渠道探测失败，请检查接口、协议和密钥")
		}
		return gin.H{"models": names, "health": gin.H{"ok": true, "checkedAt": time.Now()}}, nil
	}))
}

func (a *App) userRoutes(api *gin.RouterGroup) {
	api.PATCH("/user/profile", respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			DisplayName string `json:"displayName" binding:"required,max=80"`
		}](c)
		if err != nil {
			return nil, err
		}
		u, err := scanUser(a.DB.QueryRow(c.Request.Context(), "UPDATE users SET display_name=$2,updated_at=now() WHERE id=$1 RETURNING id,username,display_name,role,status,must_change_password,last_login_at,created_at,password_hash,group_id,(SELECT name FROM user_groups g WHERE g.id=users.group_id) AS group_name", currentUser(c).ID, strings.TrimSpace(input.DisplayName)))
		return gin.H{"user": u}, err
	}))
	api.GET("/user/logs", respond(func(c *gin.Context) (any, error) { return a.listLogs(c, false) }))
	api.GET("/user/stats", respond(func(c *gin.Context) (any, error) {
		ctx := c.Request.Context()
		id := currentUser(c).ID
		counts, err := rows(ctx, a.DB, "SELECT capability,count(*)::int AS total,count(*) FILTER(WHERE status='succeeded')::int AS succeeded,count(*) FILTER(WHERE status='failed')::int AS failed,count(*) FILTER(WHERE status IN('reviewing','queued','running'))::int AS active FROM generation_tasks WHERE user_id=$1 GROUP BY capability", id)
		if err != nil {
			return nil, err
		}
		stats := gin.H{}
		for _, capability := range []string{"images", "text", "video", "audio"} {
			stats[capability] = Row{"total": 0, "succeeded": 0, "failed": 0, "active": 0}
		}
		for _, row := range counts {
			key := str(row["capability"])
			if key == "image" {
				key = "images"
			}
			stats[key] = row
		}
		storage, err := one(ctx, a.DB, "SELECT count(*)::int AS total_count,coalesce(sum(byte_size),0)::bigint AS total_bytes FROM media_objects WHERE owner_id=$1 AND status='ready'", id)
		if err != nil {
			return nil, err
		}
		_, quota, err := storageQuotaView(ctx, a.DB, id)
		if err != nil {
			return nil, err
		}
		storage["quotaBytes"] = quota
		stats["storage"] = storage
		var canvases, assets int
		if err = a.DB.QueryRow(ctx, "SELECT (SELECT count(*) FROM canvas_projects WHERE user_id=$1),(SELECT count(*) FROM assets WHERE owner_id=$1)", id).Scan(&canvases, &assets); err != nil {
			return nil, err
		}
		stats["canvasCount"] = canvases
		stats["assetCount"] = assets
		now := time.Now().In(time.FixedZone("CST", 8*3600))
		from := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location()).UTC()
		to := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location()).AddDate(0, 1, 0).UTC()
		summary, err := walletSummary(ctx, a.DB, id, &from, &to)
		if err != nil {
			return nil, err
		}
		for key, value := range summary {
			stats[key] = value
		}
		return gin.H{"stats": stats}, nil
	}))
}

func logFilter(c *gin.Context, admin bool) (string, []any) {
	where := "true"
	args := []any{}
	add := func(column, value string) {
		if value != "" {
			args = append(args, value)
			where += " AND " + column + "=$" + str(len(args))
		}
	}
	if admin {
		add("l.user_id::text", c.Query("userId"))
	} else {
		add("l.user_id::text", currentUser(c).ID)
	}
	add("l.model_id::text", c.Query("modelId"))
	add("l.channel_id::text", c.Query("channelId"))
	add("l.type", c.Query("type"))
	add("l.status", c.Query("status"))
	for _, rangeField := range []struct{ key, operator string }{{"from", ">="}, {"to", "<="}} {
		if raw := c.Query(rangeField.key); raw != "" {
			if t, err := time.Parse(time.RFC3339, raw); err == nil {
				args = append(args, t)
				where += " AND l.started_at" + rangeField.operator + "$" + str(len(args))
			}
		}
	}
	return where, args
}
func (a *App) listLogs(c *gin.Context, admin bool) (any, error) {
	where, args := logFilter(c, admin)
	ctx := c.Request.Context()
	var total int64
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM request_logs l WHERE "+where, args...).Scan(&total); err != nil {
		return nil, err
	}
	limit, offset := pagination(c)
	args = append(args, limit, offset)
	query := "SELECT l.*,u.username,u.display_name AS user_display_name,l.model_display_name_snapshot AS model_display_name,CASE WHEN l.type='text' THEN l.task_id END AS text_request_id FROM request_logs l LEFT JOIN users u ON u.id=l.user_id WHERE " + where + " ORDER BY l.started_at DESC,l.id LIMIT $" + str(len(args)-1) + " OFFSET $" + str(len(args))
	items, err := rows(ctx, a.DB, query, args...)
	return gin.H{"logs": items, "total": total, "limit": limit, "offset": offset}, err
}

func (a *App) adminStats(c *gin.Context) (any, error) {
	ctx := c.Request.Context()
	where, args := logFilter(c, true)
	totals, err := one(ctx, a.DB, "SELECT count(DISTINCT l.task_id)::int AS request_count,count(DISTINCT l.task_id) FILTER(WHERE l.status='succeeded')::int AS succeeded_task_count,count(*) FILTER(WHERE l.type='image' AND l.status='succeeded')::int AS success_image_count,coalesce(sum(l.billed_amount),0)::text AS estimated_cost,count(*)::int AS attempt_count,count(*) FILTER(WHERE l.status='succeeded')::int AS succeeded_attempt_count,coalesce(avg(l.duration_ms),0)::float8 AS average_duration_ms,coalesce(percentile_cont(.5) WITHIN GROUP(ORDER BY l.duration_ms),0) AS p50_duration_ms,coalesce(percentile_cont(.95) WITHIN GROUP(ORDER BY l.duration_ms),0) AS p95_duration_ms FROM request_logs l WHERE "+where, args...)
	if err != nil {
		return nil, err
	}
	storage, err := one(ctx, a.DB, "SELECT count(*)::int AS total_count,coalesce(sum(byte_size),0)::bigint AS total_bytes FROM media_objects WHERE status='ready'")
	if err != nil {
		return nil, err
	}
	queue, err := one(ctx, a.DB, "SELECT count(*) FILTER(WHERE status='queued')::int AS queued_count,count(*) FILTER(WHERE status='running')::int AS running_count FROM generation_tasks")
	if err != nil {
		return nil, err
	}
	textTotals, err := one(ctx, a.DB, "SELECT count(*)::int AS request_count,count(*) FILTER(WHERE l.status='succeeded')::int AS succeeded_request_count,count(*) FILTER(WHERE l.status='failed')::int AS failed_request_count FROM request_logs l WHERE l.type='text' AND "+where, args...)
	if err != nil {
		return nil, err
	}
	users, err := rows(ctx, a.DB, "SELECT u.id,u.username,u.display_name,count(DISTINCT l.task_id)::int AS request_count,count(*) FILTER(WHERE l.type='image' AND l.status='succeeded')::int AS success_image_count,coalesce(sum(l.billed_amount),0)::text AS estimated_cost FROM request_logs l JOIN users u ON u.id=l.user_id WHERE "+where+" GROUP BY u.id ORDER BY request_count DESC", args...)
	if err != nil {
		return nil, err
	}
	models, err := rows(ctx, a.DB, "SELECT m.id,m.name,m.display_name,count(DISTINCT l.task_id)::int AS request_count,count(*) FILTER(WHERE l.type='image' AND l.status='succeeded')::int AS success_image_count,coalesce(sum(l.billed_amount),0)::text AS estimated_cost FROM request_logs l JOIN models m ON m.id=l.model_id WHERE "+where+" GROUP BY m.id ORDER BY request_count DESC", args...)
	if err != nil {
		return nil, err
	}
	channels, err := rows(ctx, a.DB, "SELECT ch.id,ch.name,count(*)::int AS attempt_count,count(*) FILTER(WHERE l.status='succeeded')::int AS succeeded_attempt_count,coalesce(avg(l.duration_ms),0)::float8 AS average_duration_ms,coalesce(percentile_cont(.5) WITHIN GROUP(ORDER BY l.duration_ms),0) AS p50_duration_ms,coalesce(percentile_cont(.95) WITHIN GROUP(ORDER BY l.duration_ms),0) AS p95_duration_ms FROM request_logs l JOIN channels ch ON ch.id=l.channel_id WHERE "+where+" GROUP BY ch.id ORDER BY attempt_count DESC", args...)
	if err != nil {
		return nil, err
	}
	byDates, err := rows(ctx, a.DB, "SELECT to_char(date_trunc('day', l.started_at), 'YYYY-MM-DD') AS date, count(DISTINCT l.task_id)::int AS request_count, count(DISTINCT l.task_id) FILTER(WHERE l.status='succeeded')::int AS succeeded_count, count(DISTINCT l.task_id) FILTER(WHERE l.status='failed')::int AS failed_count, count(*) FILTER(WHERE l.type='image' AND l.status='succeeded')::int AS success_image_count, coalesce(sum(l.billed_amount),0)::text AS estimated_cost FROM request_logs l WHERE "+where+" GROUP BY 1 ORDER BY 1 ASC", args...)
	if err != nil {
		return nil, err
	}
	byCapabilities, err := rows(ctx, a.DB, "SELECT coalesce(l.type, 'unknown') AS capability, count(DISTINCT l.task_id)::int AS request_count, count(DISTINCT l.task_id) FILTER(WHERE l.status='succeeded')::int AS succeeded_count, coalesce(sum(l.billed_amount),0)::text AS estimated_cost FROM request_logs l WHERE "+where+" GROUP BY 1 ORDER BY request_count DESC", args...)
	return gin.H{"range": gin.H{"from": c.Query("from"), "to": c.Query("to")}, "filters": gin.H{}, "storage": storage, "queue": queue, "textTotals": textTotals, "totals": totals, "byUsers": users, "byModels": models, "byChannels": channels, "byDates": byDates, "byCapabilities": byCapabilities}, err
}

// 保留 JSON 配置类型，数据库会返回已解析对象，不向用户暴露渠道细节。
func object(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	var m map[string]any
	_ = json.Unmarshal(jsonBytes(v), &m)
	if m == nil {
		return map[string]any{}
	}
	return m
}
