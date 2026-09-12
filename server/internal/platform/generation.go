package platform

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type batchInput struct {
	RequestID         string         `json:"requestId" binding:"required,uuid"`
	ModelID           string         `json:"modelId" binding:"required,uuid"`
	Prompt            string         `json:"prompt" binding:"required,max=50000"`
	Count             int            `json:"count" binding:"required,min=1,max=20"`
	CanvasProjectID   string         `json:"canvasProjectId" binding:"omitempty,uuid"`
	ReferenceMediaIDs []string       `json:"referenceMediaIds" binding:"max=20,dive,uuid"`
	Parameters        map[string]any `json:"parameters"`
}

func taskReference(task Row) string { return str(task["id"]) + ":" + str(task["run"]) }
func (a *App) generationAdmission(c *gin.Context, settings PlatformSettings) error {
	if !settings.GenerationEnabled {
		return problem(503, "generation_paused", "管理员已暂停新的生成任务")
	}
	if err := a.rate(c, "generate:user:"+currentUser(c).ID, settings.UserRPM, time.Minute); err != nil {
		return err
	}
	return a.rate(c, "generate:ip:"+hash(a.clientIP(c)), settings.IPRPM, time.Minute)
}
func modelForTask(ctx context.Context, tx pgx.Tx, id string) (Row, error) {
	model, err := one(ctx, tx, "SELECT * FROM models WHERE id=$1 AND status='published' AND deleted_at IS NULL FOR SHARE", id)
	if err != nil {
		return nil, problem(400, "model_unavailable", "模型未发布或已停用")
	}
	var available bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM model_channels b JOIN channels c ON c.id=b.channel_id WHERE b.model_id=$1 AND b.enabled AND c.capability=$2 AND c.status='active' AND c.deleted_at IS NULL AND c.auto_disabled_at IS NULL AND (c.protocol<>'anthropic' OR $2='text') AND EXISTS(SELECT 1 FROM channel_keys k WHERE k.channel_id=c.id AND k.status='active'))", id, model["capability"]).Scan(&available); err != nil {
		return nil, err
	}
	if !available {
		return nil, problem(503, "no_channel", "模型暂无可用渠道")
	}
	return model, nil
}
func activeTaskLimit(ctx context.Context, tx pgx.Tx, userID string, count, limit int) error {
	if limit <= 0 {
		return nil
	}
	var active int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM generation_tasks WHERE user_id=$1 AND status IN('reviewing','queued','running')", userID).Scan(&active); err != nil {
		return err
	}
	if active+count > limit {
		return problem(429, "active_task_limit", "排队或执行中的任务已达上限，请等待任务完成")
	}
	return nil
}

const taskSelect = "t.id,t.batch_id,t.capability,t.status,t.attempt_count,t.max_attempts,t.moderation_id,t.sequence,t.run,t.error_code,t.error_message,t.queued_at,t.started_at,t.finished_at,t.model_name,t.model_display_name,t.conversation_id,t.response_message_id,t.output_media_id,t.price_micros,t.pricing_kind,t.prompt_tokens,t.cached_tokens,t.completion_tokens,t.billed_micros,m.mime_type,m.byte_size,m.width,m.height,EXISTS(SELECT 1 FROM assets a WHERE a.media_id=t.output_media_id AND a.owner_id=t.user_id) AS is_saved"

func taskView(row Row) Row {
	if row["outputMediaId"] != nil {
		media := Row{"mediaId": row["outputMediaId"], "url": "/api/media/" + str(row["outputMediaId"]), "mimeType": row["mimeType"], "bytes": row["byteSize"], "width": row["width"], "height": row["height"], "isSaved": row["isSaved"]}
		row["output"] = media
		if row["capability"] == "image" {
			row["image"] = media
		}
	}
	row["price"] = money(integer(row["priceMicros"]))
	if row["status"] == "succeeded" || row["status"] == "failed" || row["status"] == "canceled" {
		row["billed"] = money(integer(row["billedMicros"]))
	}
	for _, key := range []string{"outputMediaId", "mimeType", "byteSize", "width", "height", "priceMicros", "billedMicros"} {
		delete(row, key)
	}
	return row
}
func (a *App) batchDetail(ctx context.Context, id, userID string) (any, error) {
	batch, err := one(ctx, a.DB, "SELECT id,canvas_project_id,model_id,capability,prompt,requested_count,parameters,created_at FROM generation_batches WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL", id, userID)
	if err != nil {
		return nil, err
	}
	tasks, err := rows(ctx, a.DB, "SELECT "+taskSelect+" FROM generation_tasks t LEFT JOIN media_objects m ON m.id=t.output_media_id WHERE t.batch_id=$1 ORDER BY t.sequence", id)
	if err != nil {
		return nil, err
	}
	for _, task := range tasks {
		taskView(task)
	}
	refs, err := rows(ctx, a.DB, "SELECT media_id FROM media_references WHERE owner_kind='batch' AND owner_id=$1 ORDER BY position", id)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, ref := range refs {
		ids = append(ids, str(ref["mediaId"]))
	}
	return gin.H{"batch": batch, "tasks": tasks, "referenceMediaIds": ids}, nil
}

func (a *App) generationRoutes(api *gin.RouterGroup) {
	api.POST("/generation-batches", respond(func(c *gin.Context) (any, error) {
		input, err := body[batchInput](c)
		if err != nil {
			return nil, err
		}
		input.RequestID = uuid.MustParse(input.RequestID).String()
		input.ModelID = uuid.MustParse(input.ModelID).String()
		input.Prompt = strings.TrimSpace(input.Prompt)
		if input.Prompt == "" {
			return nil, problem(400, "invalid_prompt", "请输入提示词")
		}
		if input.Parameters == nil {
			input.Parameters = map[string]any{}
		}
		ctx := c.Request.Context()
		u := currentUser(c)
		settings, err := a.settings(ctx, a.DB)
		if err != nil {
			return nil, err
		}
		digest := hash(string(jsonBytes(input)))
		id := uuid.NewString()
		// 完成后的重复提交先返回原任务，不受后来模型停用或频控变化影响。
		existing, err := one(ctx, a.DB, "SELECT id,request_hash FROM generation_batches WHERE user_id=$1 AND request_key=$2", u.ID, input.RequestID)
		if err == nil {
			if existing["requestHash"] != digest {
				return nil, problem(409, "idempotency_conflict", "重复请求的生成参数不一致")
			}
			return a.batchDetail(ctx, str(existing["id"]), u.ID)
		}
		if !errors.Is(err, notFound) {
			return nil, err
		}
		if err = a.generationAdmission(c, settings); err != nil {
			return nil, err
		}
		decision, err := a.checkSensitive(ctx, sensitiveInput(input.Prompt, input.Parameters), u.ID)
		if err != nil {
			return nil, err
		} else if decision.Action == "block" {
			return nil, problem(400, "sensitive_prompt", "提示词包含平台不允许的内容，请修改后重试")
		}
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if err := lockWallet(ctx, tx, u.ID); err != nil {
				return err
			}
			existing, err := one(ctx, tx, "SELECT id,request_hash FROM generation_batches WHERE user_id=$1 AND request_key=$2", u.ID, input.RequestID)
			if err == nil {
				if existing["requestHash"] != digest {
					return problem(409, "idempotency_conflict", "重复请求的生成参数不一致")
				}
				id = str(existing["id"])
				return nil
			}
			if !errors.Is(err, notFound) {
				return err
			}
			if err = activeTaskLimit(ctx, tx, u.ID, input.Count, settings.ActiveTasks); err != nil {
				return err
			}
			model, err := modelForTask(ctx, tx, input.ModelID)
			if err != nil {
				return err
			}
			if err = a.modelAccess(ctx, tx, u.ID, input.ModelID); err != nil {
				return err
			}
			if model["capability"] == "text" {
				return problem(400, "invalid_capability", "文本请使用对话生成入口")
			}
			// 视频时长在创建时统一规范化，后续计费与上游请求都使用保存后的值。
			if model["capability"] == "video" {
				seconds, err := paramSeconds(input.Parameters)
				if err != nil {
					return err
				}
				if !seconds.IsZero() {
					input.Parameters["seconds"] = seconds.String()
					delete(input.Parameters, "durationSeconds")
				}
			}
			if err = projectAccess(ctx, tx, input.CanvasProjectID, u.ID); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "INSERT INTO generation_batches(id,user_id,model_id,canvas_project_id,capability,prompt,requested_count,parameters,request_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", id, u.ID, input.ModelID, nullable(input.CanvasProjectID), model["capability"], input.Prompt, input.Count, jsonBytes(input.Parameters), input.RequestID, digest); err != nil {
				return err
			}
			if err = syncMediaRefs(ctx, tx, "batch", id, u.ID, input.ReferenceMediaIDs); err != nil {
				return err
			}
			discount, err := a.groupDiscount(ctx, tx, &u)
			if err != nil {
				return err
			}
			pricing, err := pricingSnapshot(model, discount, input.Parameters, 0)
			if err != nil {
				return err
			}
			price := integer(pricing["priceMicros"])
			pricePerSecond, seconds := pricing["pricePerSecond"], pricing["seconds"]
			if model["capability"] == "video" && seconds != nil {
				input.Parameters["seconds"] = seconds
			}
			moderationID, status, err := a.newModeration(ctx, tx, u.ID, decision, Row{"prompt": input.Prompt, "parameters": input.Parameters, "capability": model["capability"], "modelDisplayName": model["displayName"], "taskCount": input.Count})
			if err != nil {
				return err
			}
			for i := 0; i < input.Count; i++ {
				taskID := uuid.NewString()
				if _, err = changeWallet(ctx, tx, u.ID, "hold", taskID+":1", -price, price, "生成预冻结"); err != nil {
					return err
				}
				if _, err = tx.Exec(ctx, "INSERT INTO generation_tasks(id,batch_id,user_id,model_id,capability,sequence,prompt,parameters,price_micros,price_per_second,seconds,group_discount,model_name,model_display_name,moderation_id,status,max_attempts) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)", taskID, id, u.ID, input.ModelID, model["capability"], i, input.Prompt, jsonBytes(input.Parameters), price, pricePerSecond, seconds, discount.String(), model["name"], model["displayName"], moderationID, status, settings.MaxAttempts); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
		return a.batchDetail(ctx, id, u.ID)
	}))
	api.GET("/generation-batches", respond(func(c *gin.Context) (any, error) {
		limit, offset := pagination(c)
		items, err := rows(c.Request.Context(), a.DB, `SELECT b.id,b.canvas_project_id,b.model_id,b.capability,b.prompt,b.requested_count,b.parameters,b.created_at,
        jsonb_build_object('totalCount',count(t.id),'succeededCount',count(t.id) FILTER(WHERE t.status='succeeded'),'failedCount',count(t.id) FILTER(WHERE t.status IN('failed','canceled')),'activeCount',count(t.id) FILTER(WHERE t.status IN('reviewing','queued','running')),'savedCount',count(t.id) FILTER(WHERE EXISTS(SELECT 1 FROM assets a WHERE a.media_id=t.output_media_id)),'thumbnailMediaIds',coalesce(jsonb_agg(t.output_media_id ORDER BY t.sequence) FILTER(WHERE t.output_media_id IS NOT NULL),'[]')) AS summary
        FROM generation_batches b LEFT JOIN generation_tasks t ON t.batch_id=b.id WHERE b.user_id=$1 AND b.deleted_at IS NULL AND ($2='' OR b.capability=$2) GROUP BY b.id ORDER BY b.created_at DESC,b.id LIMIT $3 OFFSET $4`, currentUser(c).ID, c.Query("capability"), limit, offset)
		return gin.H{"batches": items}, err
	}))
	api.GET("/generation-batches/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		return a.batchDetail(c.Request.Context(), id, currentUser(c).ID)
	}))
	api.DELETE("/generation-batches/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		u := currentUser(c)
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if err := lockWallet(ctx, tx, u.ID); err != nil {
				return err
			}
			if _, err := one(ctx, tx, "SELECT id FROM generation_batches WHERE id=$1 AND user_id=$2 FOR UPDATE", id, u.ID); err != nil {
				return err
			}
			var active bool
			if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM generation_tasks WHERE batch_id=$1 AND status IN('reviewing','queued','running'))", id).Scan(&active); err != nil {
				return err
			}
			if active {
				return problem(409, "tasks_active", "请先等待或取消进行中的任务")
			}
			if _, err := tx.Exec(ctx, "DELETE FROM media_references WHERE (owner_kind='batch' AND owner_id=$1) OR (owner_kind='task' AND owner_id IN(SELECT id FROM generation_tasks WHERE batch_id=$1))", id); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "UPDATE generation_tasks SET output_media_id=NULL WHERE batch_id=$1", id); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, "UPDATE generation_batches SET deleted_at=now() WHERE id=$1", id)
			return err
		})
		return nil, err
	}))
	api.GET("/generation-tasks/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		row, err := one(c.Request.Context(), a.DB, "SELECT "+taskSelect+" FROM generation_tasks t LEFT JOIN media_objects m ON m.id=t.output_media_id WHERE t.id=$1 AND t.user_id=$2", id, currentUser(c).ID)
		if err != nil {
			return nil, err
		}
		return gin.H{"task": taskView(row)}, nil
	}))
	api.POST("/generation-tasks/:id/cancel", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		return nil, a.cancelTask(c.Request.Context(), id, currentUser(c).ID, false)
	}))
	api.POST("/generation-batches/tasks/:taskId/retry", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "taskId")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		u := currentUser(c)
		settings, err := a.settings(ctx, a.DB)
		if err != nil {
			return nil, err
		}
		if err = a.generationAdmission(c, settings); err != nil {
			return nil, err
		}
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if err := lockWallet(ctx, tx, u.ID); err != nil {
				return err
			}
			task, err := one(ctx, tx, "SELECT t.* FROM generation_tasks t JOIN generation_batches b ON b.id=t.batch_id WHERE t.id=$1 AND t.user_id=$2 AND b.deleted_at IS NULL FOR UPDATE OF t", id, u.ID)
			if err != nil {
				return err
			}
			if task["status"] == "reviewing" || task["status"] == "queued" || task["status"] == "running" {
				return nil
			}
			if task["status"] != "failed" && task["status"] != "canceled" {
				return problem(409, "task_completed", "已完成的任务不能重试")
			}
			decision, err := a.checkSensitive(ctx, sensitiveInput(str(task["prompt"]), object(task["parameters"])), u.ID)
			if err != nil {
				return err
			}
			if decision.Action == "block" {
				return problem(400, "sensitive_prompt", "提示词包含平台不允许的内容，请修改后重新提交")
			}
			moderationID, status, err := a.newModeration(ctx, tx, u.ID, decision, Row{"prompt": task["prompt"], "parameters": task["parameters"], "capability": task["capability"], "modelDisplayName": task["modelDisplayName"], "taskCount": 1})
			if err != nil {
				return err
			}
			if err = activeTaskLimit(ctx, tx, u.ID, 1, settings.ActiveTasks); err != nil {
				return err
			}
			model, err := modelForTask(ctx, tx, str(task["modelId"]))
			if err != nil {
				return err
			}
			if err = a.modelAccess(ctx, tx, u.ID, str(task["modelId"])); err != nil {
				return err
			}
			discount, err := a.groupDiscount(ctx, tx, &u)
			if err != nil {
				return err
			}
			pricing, err := pricingSnapshot(model, discount, object(task["parameters"]), 0)
			if err != nil {
				return err
			}
			price := integer(pricing["priceMicros"])
			run := integer(task["run"]) + 1
			if _, err = changeWallet(ctx, tx, u.ID, "hold", id+":"+str(run), -price, price, "重试预冻结"); err != nil {
				return err
			}
			_, err = tx.Exec(ctx, "UPDATE generation_tasks SET status=$8,moderation_id=$7,max_attempts=$9,attempt_count=0,upstream_completed=false,attempted_key_ids='{}',failed_channel_ids='{}',slot_token=NULL,run=$2,price_micros=$3,price_per_second=$4,seconds=$5,group_discount=$6,billed_micros=NULL,calculated_micros=NULL,channel_id=NULL,channel_snapshot=NULL,upstream_task_id=NULL,upstream_model=NULL,worker_token=NULL,error_code=NULL,error_message=NULL,queued_at=now(),available_at=now(),started_at=NULL,finished_at=NULL,deadline=NULL WHERE id=$1", id, run, price, pricing["pricePerSecond"], pricing["seconds"], pricing["groupDiscount"], moderationID, status, settings.MaxAttempts)
			return err
		})
		if err != nil {
			return nil, err
		}
		task, err := one(ctx, a.DB, "SELECT "+taskSelect+" FROM generation_tasks t LEFT JOIN media_objects m ON m.id=t.output_media_id WHERE t.id=$1", id)
		if err != nil {
			return nil, err
		}
		return gin.H{"task": taskView(task)}, nil
	}))
	a.textRoutes(api)
}

func (a *App) cancelTask(ctx context.Context, id, userID string, admin bool) error {
	row, err := one(ctx, a.DB, "SELECT user_id FROM generation_tasks WHERE id=$1 AND (user_id::text=$2 OR $3)", id, userID, admin)
	if err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		owner := str(row["userId"])
		if err := lockWallet(ctx, tx, owner); err != nil {
			return err
		}
		task, err := one(ctx, tx, "SELECT * FROM generation_tasks WHERE id=$1 FOR UPDATE", id)
		if err != nil {
			return err
		}
		if task["status"] != "reviewing" && task["status"] != "queued" && task["status"] != "running" {
			return nil
		}
		price := integer(task["priceMicros"])
		if _, err = changeWallet(ctx, tx, owner, "release", taskReference(task), price, -price, "任务取消退回冻结余额"); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "UPDATE generation_tasks SET status='canceled',worker_token=NULL,error_code='canceled',error_message='任务已取消',finished_at=now() WHERE id=$1", id); err != nil {
			return err
		}
		if task["moderationId"] != nil {
			if _, err = tx.Exec(ctx, "UPDATE moderation_reviews SET status='canceled',reviewed_at=now() WHERE id=$1 AND status='pending' AND NOT EXISTS(SELECT 1 FROM generation_tasks WHERE moderation_id=$1 AND status='reviewing')", task["moderationId"]); err != nil {
				return err
			}
		}
		if _, err = tx.Exec(ctx, "UPDATE upstream_cost_entries SET status='canceled',updated_at=now() WHERE task_id=$1 AND status='running'", id); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, "UPDATE request_logs SET status='failed',error_category='canceled',error_message='任务已取消',finished_at=now() WHERE task_id=$1 AND status='running'", id)
		return err
	})
}
