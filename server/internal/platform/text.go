package platform

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type textInput struct {
	RequestID          string         `json:"requestId" binding:"required,uuid"`
	ConversationID     string         `json:"conversationId" binding:"omitempty,uuid"`
	CanvasProjectID    string         `json:"canvasProjectId" binding:"omitempty,uuid"`
	Title              string         `json:"title" binding:"max=200"`
	ModelID            string         `json:"modelId" binding:"required,uuid"`
	Content            string         `json:"content" binding:"max=100000"`
	SystemPrompt       string         `json:"systemPrompt" binding:"max=100000"`
	AttachmentMediaIDs []string       `json:"attachmentMediaIds" binding:"max=20,dive,uuid"`
	Parameters         map[string]any `json:"parameters"`
	Action             string         `json:"action" binding:"omitempty,oneof=edit regenerate"`
	TargetMessageID    string         `json:"targetMessageId" binding:"omitempty,uuid"`
}

func modelTextParameters(model Row, params map[string]any) (map[string]any, error) {
	config := object(model["config"])
	if value := config["contextWindowTokens"]; value != nil {
		var capacity int64
		if err := json.Unmarshal(jsonBytes(value), &capacity); err != nil || capacity <= 0 {
			return nil, problem(400, "invalid_context_window", "模型上下文容量必须为空或正整数")
		}
	}
	limit := explicitTextTokens(Row{"maxOutputTokens": config["maxOutputTokens"]})
	if limit == 0 {
		return nil, problem(400, "model_output_limit_required", "此文本模型尚未配置有效的输出上限，请联系管理员")
	}
	var efforts []string
	if err := json.Unmarshal(jsonBytes(config["reasoningEfforts"]), &efforts); err != nil {
		return nil, problem(400, "invalid_reasoning_config", "模型思考强度配置必须为选项列表")
	}
	for i, effort := range efforts {
		if !slices.Contains([]string{"low", "medium", "high", "xhigh", "max", "ultra"}, effort) || slices.Contains(efforts[:i], effort) {
			return nil, problem(400, "invalid_reasoning_config", "模型思考强度配置包含无效或重复选项")
		}
	}
	effort, alias := str(params["reasoningEffort"]), str(params["reasoning_effort"])
	if effort == "" {
		effort = alias
	} else if alias != "" && alias != effort {
		return nil, problem(400, "invalid_reasoning_effort", "思考强度参数不一致")
	}
	if effort != "" && effort != "auto" && !slices.Contains(efforts, effort) {
		return nil, problem(400, "invalid_reasoning_effort", "此模型未开放该思考强度，请重新选择")
	}
	parameters := maps.Clone(params)
	if parameters == nil {
		parameters = map[string]any{}
	}
	for _, key := range []string{"max_tokens", "max_completion_tokens", "maxOutputTokens", "reasoningEffort", "reasoning_effort"} {
		delete(parameters, key)
	}
	if effort != "" && effort != "auto" {
		parameters["reasoningEffort"] = effort
	}
	parameters["max_tokens"] = limit
	return parameters, nil
}

const textMessageSelect = `m.id,m.role,m.content,m.created_at,m.superseded_at,
	t.id AS request_id,t.request_message_id,t.model_display_name,t.billed_micros,
	t.prompt_tokens,t.cached_tokens,t.completion_tokens,t.finish_reason,t.action,t.target_message_id`

const textRequestSelect = `id,conversation_id,request_message_id,response_message_id,model_display_name,status,
	(status IN('reviewing','queued','running') AND upstream_submitted_at IS NULL) AS can_cancel,
	error_code,error_message,partial_text,stream_sequence,run,attempt_count,max_attempts,
	prompt_tokens,cached_tokens,completion_tokens,finish_reason,action,target_message_id,
	billed_micros,price_micros,queued_at AS created_at,finished_at`

func publicTextMessage(message Row) Row {
	if message["billedMicros"] != nil {
		message["billed"] = money(integer(message["billedMicros"]))
	}
	delete(message, "billedMicros")
	return message
}

// 编辑和重新生成只替换一条有效时间线，旧内容保留供只读查看。
// 返回被替换的首条 user 消息序号；报价和提交共用同一个截点。
func resolveTextRevision(ctx context.Context, q querier, conversation string, input *textInput) (int64, error) {
	if input.Action == "" && input.TargetMessageID == "" {
		return 0, nil
	}
	if conversation == "" || input.TargetMessageID == "" || (input.Action != "edit" && input.Action != "regenerate") {
		return 0, problem(400, "invalid_text_action", "请指定当前对话中要编辑或重新生成的消息")
	}
	target, err := one(ctx, q, "SELECT id,role,content,sequence FROM messages WHERE id=$1 AND conversation_id=$2 AND superseded_at IS NULL", input.TargetMessageID, conversation)
	if errors.Is(err, notFound) {
		return 0, problem(409, "message_superseded", "消息已不在当前对话的有效记录中，请刷新后重试")
	}
	if err != nil {
		return 0, err
	}
	if input.Action == "edit" {
		if target["role"] != "user" {
			return 0, problem(400, "invalid_text_action", "只能编辑用户消息")
		}
		return integer(target["sequence"]), nil
	}
	if target["role"] != "assistant" {
		return 0, problem(400, "invalid_text_action", "只能重新生成助手回复")
	}
	source, err := one(ctx, q, `SELECT m.id,m.content,m.sequence FROM generation_tasks t JOIN messages m ON m.id=t.request_message_id
		WHERE t.response_message_id=$1 AND t.conversation_id=$2 AND m.conversation_id=$2 AND m.role='user' AND m.superseded_at IS NULL`, input.TargetMessageID, conversation)
	if err != nil {
		return 0, err
	}
	refs, err := rows(ctx, q, "SELECT media_id FROM media_references WHERE owner_kind='message' AND owner_id=$1 ORDER BY position", source["id"])
	if err != nil {
		return 0, err
	}
	input.Content, input.AttachmentMediaIDs = str(source["content"]), nil
	for _, ref := range refs {
		input.AttachmentMediaIDs = append(input.AttachmentMediaIDs, str(ref["mediaId"]))
	}
	return integer(source["sequence"]), nil
}

func validateTextImages(ctx context.Context, q querier, model Row, conversation string, before int64, attachments []string) error {
	if len(attachments) > 0 {
		var nonImage bool
		if err := q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM media_objects WHERE id=ANY($1::uuid[]) AND mime_type NOT LIKE 'image/%')", attachments).Scan(&nonImage); err != nil {
			return err
		}
		if nonImage {
			return problem(400, "invalid_media", "文本附件仅支持图片文件")
		}
	}
	if object(model["config"])["imageInput"] == true {
		return nil
	}
	hasImages := len(attachments) > 0
	if !hasImages && conversation != "" {
		if err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM messages m JOIN media_references r ON r.owner_kind='message' AND r.owner_id=m.id
			WHERE m.conversation_id=$1 AND ($2::bigint=0 OR m.sequence<$2) AND `+approvedMessage+`)`, conversation, before).Scan(&hasImages); err != nil {
			return err
		}
	}
	if hasImages {
		return problem(400, "image_input_unsupported", "本次输入或当前对话历史包含图片，请选择支持图片输入的模型，或新建纯文本对话")
	}
	return nil
}

func (a *App) textRoutes(api *gin.RouterGroup) {
	api.GET("/text/requests/:id/events", a.textEvents)
	api.POST("/text/conversations", a.rateLimit("conversation", 30, time.Minute), respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			CanvasProjectID string `json:"canvasProjectId" binding:"omitempty,uuid"`
			Title           string `json:"title" binding:"max=200"`
		}](c)
		if err != nil {
			return nil, err
		}
		if input.Title == "" {
			input.Title = "新对话"
		}
		ctx := c.Request.Context()
		if input.CanvasProjectID != "" {
			if err = projectWriteAccess(ctx, a.DB, input.CanvasProjectID, currentUser(c).ID); err != nil {
				return nil, err
			}
		}
		conversation, err := one(ctx, a.DB, "INSERT INTO conversations(user_id,canvas_project_id,title) VALUES($1,$2,$3) RETURNING *", currentUser(c).ID, nullable(input.CanvasProjectID), input.Title)
		return gin.H{"conversation": conversation}, err
	}))
	api.GET("/text/conversations", respond(func(c *gin.Context) (any, error) {
		limit, offset := pagination(c)
		items, err := rows(c.Request.Context(), a.DB, `SELECT c.id,c.title,c.canvas_project_id,c.created_at,c.updated_at,c.pinned,c.archived_at,
			match.id AS matched_message_id,match.excerpt FROM conversations c
			LEFT JOIN LATERAL (SELECT m.id,substring(m.content FROM greatest(1,strpos(lower(m.content),lower($2))-32) FOR 160) AS excerpt
				FROM messages m WHERE m.conversation_id=c.id AND $2<>'' AND strpos(lower(m.content),lower($2))>0 ORDER BY m.sequence DESC LIMIT 1) match ON true
			WHERE c.user_id=$1 AND c.deleted_at IS NULL AND (c.archived_at IS NOT NULL)=$3
			AND ($2='' OR strpos(lower(c.title),lower($2))>0 OR match.id IS NOT NULL)
			ORDER BY c.pinned DESC,c.updated_at DESC,c.id DESC LIMIT $4 OFFSET $5`, currentUser(c).ID, strings.TrimSpace(c.Query("keyword")), c.Query("archived") == "true", limit, offset)
		return gin.H{"conversations": items}, err
	}))
	api.PATCH("/text/conversations/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			Title    *string `json:"title" binding:"omitempty,max=200"`
			Pinned   *bool   `json:"pinned"`
			Archived *bool   `json:"archived"`
		}](c)
		if err != nil {
			return nil, err
		}
		if input.Title != nil {
			*input.Title = strings.TrimSpace(*input.Title)
			if *input.Title == "" {
				return nil, problem(400, "invalid_title", "对话名称不能为空")
			}
		}
		conversation, err := one(c.Request.Context(), a.DB, `UPDATE conversations SET title=coalesce($2,title),pinned=coalesce($3,pinned),
			archived_at=CASE WHEN $4::boolean IS NULL THEN archived_at WHEN $4 THEN coalesce(archived_at,now()) ELSE NULL END,updated_at=now()
			WHERE id=$1 AND user_id=$5 AND deleted_at IS NULL RETURNING id,title,canvas_project_id,created_at,updated_at,pinned,archived_at`, id, input.Title, input.Pinned, input.Archived, currentUser(c).ID)
		return gin.H{"conversation": conversation}, err
	}))
	api.DELETE("/text/conversations/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		u := currentUser(c)
		ctx := c.Request.Context()
		// 先联动取消进行中的任务再软删会话：取消失败时会话保留，用户可重试删除。
		activeTasks, err := rows(ctx, a.DB, "SELECT id FROM generation_tasks WHERE conversation_id=$1 AND user_id=$2 AND status IN ('reviewing','queued','running')", id, u.ID)
		if err != nil {
			return nil, err
		}
		for _, task := range activeTasks {
			if err = a.cancelTask(ctx, str(task["id"]), u.ID, false); err != nil {
				return nil, err
			}
		}
		_, err = one(ctx, a.DB, "UPDATE conversations SET deleted_at=now() WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING id", id, u.ID)
		if err != nil {
			return nil, err
		}
		return nil, nil
	}))
	api.GET("/text/conversations/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		conversation, err := one(ctx, a.DB, "SELECT id,title,canvas_project_id,pinned,archived_at,model_id,parameters FROM conversations WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL", id, currentUser(c).ID)
		if err != nil {
			return nil, err
		}
		messages, err := rows(ctx, a.DB, "SELECT "+textMessageSelect+" FROM messages m LEFT JOIN generation_tasks t ON t.response_message_id=m.id WHERE m.conversation_id=$1 ORDER BY m.sequence", id)
		if err != nil {
			return nil, err
		}
		if len(messages) > 0 {
			messageIDs := make([]string, 0, len(messages))
			for _, m := range messages {
				publicTextMessage(m)
				messageIDs = append(messageIDs, str(m["id"]))
			}
			refs, err := rows(ctx, a.DB, "SELECT mr.owner_id AS message_id,m.* FROM media_references mr JOIN media_objects m ON m.id=mr.media_id WHERE mr.owner_kind='message' AND mr.owner_id=ANY($1::uuid[]) ORDER BY mr.position", messageIDs)
			if err != nil {
				return nil, err
			}
			attachments := map[string][]Row{}
			for _, ref := range refs {
				owner := str(ref["messageId"])
				delete(ref, "messageId")
				attachments[owner] = append(attachments[owner], publicMedia(ref))
			}
			for _, m := range messages {
				if items := attachments[str(m["id"])]; len(items) > 0 {
					m["attachments"] = items
				}
			}
		}
		latest, err := one(ctx, a.DB, "SELECT "+textRequestSelect+" FROM generation_tasks WHERE conversation_id=$1 ORDER BY queued_at DESC,id DESC LIMIT 1", id)
		if errors.Is(err, notFound) {
			err = nil
		}
		if latest != nil {
			latest["billed"] = money(integer(latest["billedMicros"]))
			latest["price"] = money(integer(latest["priceMicros"]))
			delete(latest, "billedMicros")
			delete(latest, "priceMicros")
		}
		return gin.H{"conversation": conversation, "messages": messages, "latestRequest": latest}, err
	}))
	api.GET("/text/requests/:id", respond(a.textRequestDetail))
	api.POST("/text/requests", respond(func(c *gin.Context) (any, error) {
		input, err := body[textInput](c)
		if err != nil {
			return nil, err
		}
		input.RequestID = uuid.MustParse(input.RequestID).String()
		input.ModelID = uuid.MustParse(input.ModelID).String()
		if input.ConversationID != "" {
			input.ConversationID = uuid.MustParse(input.ConversationID).String()
		}
		if input.TargetMessageID != "" {
			input.TargetMessageID = uuid.MustParse(input.TargetMessageID).String()
		}
		if input.Parameters == nil {
			input.Parameters = map[string]any{}
		}
		if input.Action != "regenerate" && strings.TrimSpace(input.Content) == "" && len(input.AttachmentMediaIDs) == 0 {
			return nil, problem(400, "invalid_prompt", "请输入文本内容")
		}
		digest := hash(string(jsonBytes(input)))
		ctx := c.Request.Context()
		u := currentUser(c)
		conversationID := input.ConversationID
		existing, err := one(ctx, a.DB, "SELECT id,request_hash,conversation_id FROM generation_tasks WHERE id=$1 AND user_id=$2", input.RequestID, u.ID)
		if err == nil {
			if existing["requestHash"] != digest {
				return nil, problem(409, "idempotency_conflict", "同一请求编号的文本参数不一致")
			}
			return gin.H{"conversationId": existing["conversationId"], "requestId": input.RequestID}, nil
		}
		if !errors.Is(err, notFound) {
			return nil, err
		}
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
			old, err := one(ctx, tx, "SELECT id,request_hash,conversation_id FROM generation_tasks WHERE id=$1 AND user_id=$2", input.RequestID, u.ID)
			if err == nil {
				if old["requestHash"] != digest {
					return problem(409, "idempotency_conflict", "同一请求编号的文本参数不一致")
				}
				conversationID = str(old["conversationId"])
				return nil
			}
			if !errors.Is(err, notFound) {
				return err
			}
			if err = requireNoDebt(ctx, tx, u.ID); err != nil {
				return err
			}
			if err = activeTaskLimit(ctx, tx, u.ID, 1, settings.ActiveTasks); err != nil {
				return err
			}
			model, err := modelForTask(ctx, tx, input.ModelID)
			if err != nil {
				return err
			}
			if err = a.modelAccess(ctx, tx, u.ID, input.ModelID); err != nil {
				return err
			}
			if model["capability"] != "text" {
				return problem(400, "invalid_capability", "请选择文本模型")
			}
			input.Parameters, err = modelTextParameters(model, input.Parameters)
			if err != nil {
				return err
			}
			if input.CanvasProjectID != "" {
				if err = projectWriteAccess(ctx, tx, input.CanvasProjectID, u.ID); err != nil {
					return err
				}
			}
			if conversationID == "" {
				conversationID = uuid.NewString()
				title := input.Title
				if title == "" {
					title = "新对话"
				}
				if _, err = tx.Exec(ctx, "INSERT INTO conversations(id,user_id,title,canvas_project_id) VALUES($1,$2,$3,$4)", conversationID, u.ID, title, nullable(input.CanvasProjectID)); err != nil {
					return err
				}
			} else {
				conversation, err := one(ctx, tx, "SELECT canvas_project_id FROM conversations WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE", conversationID, u.ID)
				if err != nil {
					return err
				}
				if canvasID := str(conversation["canvasProjectId"]); canvasID != "" {
					if err := projectWriteAccess(ctx, tx, canvasID, u.ID); err != nil {
						return err
					}
				}
			}
			var active bool
			if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM generation_tasks WHERE conversation_id=$1 AND status IN('reviewing','queued','running'))", conversationID).Scan(&active); err != nil {
				return err
			}
			if active {
				return problem(409, "conversation_busy", "请等待本次对话生成完成")
			}
			before, err := resolveTextRevision(ctx, tx, conversationID, &input)
			if err != nil {
				return err
			}
			decision, err := a.checkSensitive(ctx, tx, sensitiveInput(input.Content+"\n"+input.SystemPrompt, input.Parameters), u.ID)
			if err != nil {
				return err
			} else if decision.Action == "block" {
				return problem(400, "sensitive_prompt", "输入内容包含平台不允许的内容，请修改后重试")
			}
			if err = validateTextImages(ctx, tx, model, conversationID, before, input.AttachmentMediaIDs); err != nil {
				return err
			}
			if before > 0 {
				if _, err = tx.Exec(ctx, "UPDATE messages SET superseded_at=now() WHERE conversation_id=$1 AND superseded_at IS NULL AND sequence>=$2", conversationID, before); err != nil {
					return err
				}
			}
			messageID := uuid.NewString()
			if _, err = tx.Exec(ctx, "INSERT INTO messages(id,conversation_id,role,content) VALUES($1,$2,'user',$3)", messageID, conversationID, input.Content); err != nil {
				return err
			}
			if err = syncMediaRefs(ctx, tx, "message", messageID, u.ID, input.AttachmentMediaIDs); err != nil {
				return err
			}
			// token 计价模型按预估用量冻结；实际费用以结算为准，多退少补。
			discount, err := a.groupDiscount(ctx, tx, &u)
			if err != nil {
				return err
			}
			estimate, err := promptEstimate(ctx, tx, conversationID, "", input.SystemPrompt)
			if err != nil {
				return err
			}
			pricing, err := pricingSnapshot(model, discount, input.Parameters, estimate)
			if err != nil {
				return err
			}
			price := integer(pricing["priceMicros"])
			pricingKind, inputPrice, cachedPrice, outputPrice := pricing["pricingKind"], pricing["inputPricePerMillion"], pricing["cachedPricePerMillion"], pricing["outputPricePerMillion"]
			if _, err = changeWallet(ctx, tx, u.ID, "hold", input.RequestID+":1", -price, price, "文本生成预冻结"); err != nil {
				return err
			}
			parameters := input.Parameters
			parameters["systemPrompt"] = input.SystemPrompt
			moderationID, status, err := a.newModeration(ctx, tx, u.ID, decision, Row{"prompt": input.Content, "parameters": parameters, "capability": "text", "modelDisplayName": model["displayName"], "taskCount": 1})
			if err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "INSERT INTO generation_tasks(id,user_id,model_id,capability,prompt,parameters,price_micros,pricing_kind,input_price_per_million,cached_price_per_million,output_price_per_million,group_discount,request_hash,conversation_id,request_message_id,model_name,model_display_name,moderation_id,status,max_attempts,action,target_message_id) VALUES($1,$2,$3,'text',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)", input.RequestID, u.ID, input.ModelID, input.Content, jsonBytes(parameters), price, pricingKind, inputPrice, cachedPrice, outputPrice, discount.String(), digest, conversationID, messageID, model["name"], model["displayName"], moderationID, status, effectiveMaxAttempts(settings, model), input.Action, nullable(input.TargetMessageID)); err != nil {
				return err
			}
			_, err = tx.Exec(ctx, "UPDATE conversations SET updated_at=now(),model_id=$2,parameters=$3 WHERE id=$1", conversationID, input.ModelID, jsonBytes(parameters))
			return err
		})
		return gin.H{"conversationId": conversationID, "requestId": input.RequestID}, err
	}))
}
func (a *App) textRequestDetail(c *gin.Context) (any, error) {
	id, err := idParam(c, "id")
	if err != nil {
		return nil, err
	}
	ctx := c.Request.Context()
	task, err := one(ctx, a.DB, "SELECT "+textRequestSelect+" FROM generation_tasks WHERE id=$1 AND user_id=$2 AND capability='text'", id, currentUser(c).ID)
	if err != nil {
		return nil, err
	}
	var message Row
	task["billed"], task["price"] = money(integer(task["billedMicros"])), money(integer(task["priceMicros"]))
	delete(task, "billedMicros")
	delete(task, "priceMicros")
	if task["responseMessageId"] != nil {
		message, err = one(ctx, a.DB, "SELECT "+textMessageSelect+" FROM messages m LEFT JOIN generation_tasks t ON t.response_message_id=m.id WHERE m.id=$1", task["responseMessageId"])
		if message != nil {
			publicTextMessage(message)
		}
	}
	return gin.H{"request": task, "message": message}, err
}
