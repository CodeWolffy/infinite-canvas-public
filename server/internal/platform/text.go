package platform

import (
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strings"

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
	Content            string         `json:"content" binding:"required,max=100000"`
	SystemPrompt       string         `json:"systemPrompt" binding:"max=100000"`
	AttachmentMediaIDs []string       `json:"attachmentMediaIds" binding:"max=20,dive,uuid"`
	Parameters         map[string]any `json:"parameters"`
}

func modelTextParameters(model Row, params map[string]any) (map[string]any, error) {
	config := object(model["config"])
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

func (a *App) textRoutes(api *gin.RouterGroup) {
	api.GET("/text/requests/:id/events", a.textEvents)
	api.POST("/text/conversations", respond(func(c *gin.Context) (any, error) {
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
		if err = projectAccess(ctx, a.DB, input.CanvasProjectID, currentUser(c).ID); err != nil {
			return nil, err
		}
		conversation, err := one(ctx, a.DB, "INSERT INTO conversations(user_id,canvas_project_id,title) VALUES($1,$2,$3) RETURNING *", currentUser(c).ID, nullable(input.CanvasProjectID), input.Title)
		return gin.H{"conversation": conversation}, err
	}))
	api.GET("/text/conversations", respond(func(c *gin.Context) (any, error) {
		limit, offset := pagination(c)
		items, err := rows(c.Request.Context(), a.DB, "SELECT id,title,canvas_project_id,created_at,updated_at FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3", currentUser(c).ID, limit, offset)
		return gin.H{"conversations": items}, err
	}))
	api.GET("/text/conversations/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		conversation, err := one(ctx, a.DB, "SELECT id,title,canvas_project_id FROM conversations WHERE id=$1 AND user_id=$2", id, currentUser(c).ID)
		if err != nil {
			return nil, err
		}
		messages, err := rows(ctx, a.DB, "SELECT id,role,content,created_at FROM messages WHERE conversation_id=$1 ORDER BY sequence", id)
		if err != nil {
			return nil, err
		}
		latest, err := one(ctx, a.DB, "SELECT id,conversation_id,model_id,parameters,status,error_code,error_message,response_message_id,partial_text,stream_sequence,run,attempt_count,max_attempts,billed_micros,price_micros,queued_at AS created_at,finished_at FROM generation_tasks WHERE conversation_id=$1 ORDER BY queued_at DESC LIMIT 1", id)
		if errors.Is(err, notFound) {
			err = nil
		}
		if latest != nil {
			conversation["modelId"], conversation["parameters"] = latest["modelId"], latest["parameters"]
			delete(latest, "modelId")
			delete(latest, "parameters")
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
		if input.Parameters == nil {
			input.Parameters = map[string]any{}
		}
		if strings.TrimSpace(input.Content) == "" {
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
		decision, err := a.checkSensitive(ctx, sensitiveInput(input.Content+"\n"+input.SystemPrompt, input.Parameters), u.ID)
		if err != nil {
			return nil, err
		} else if decision.Action == "block" {
			return nil, problem(400, "sensitive_prompt", "输入内容包含平台不允许的内容，请修改后重试")
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
			if err = projectAccess(ctx, tx, input.CanvasProjectID, u.ID); err != nil {
				return err
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
				if _, err = one(ctx, tx, "SELECT id FROM conversations WHERE id=$1 AND user_id=$2 FOR UPDATE", conversationID, u.ID); err != nil {
					return err
				}
			}
			var active bool
			if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM generation_tasks WHERE conversation_id=$1 AND status IN('reviewing','queued','running'))", conversationID).Scan(&active); err != nil {
				return err
			}
			if active {
				return problem(409, "conversation_busy", "请等待本次对话生成完成")
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
			if _, err = tx.Exec(ctx, "INSERT INTO generation_tasks(id,user_id,model_id,capability,prompt,parameters,price_micros,pricing_kind,input_price_per_million,cached_price_per_million,output_price_per_million,group_discount,request_hash,conversation_id,request_message_id,model_name,model_display_name,moderation_id,status,max_attempts) VALUES($1,$2,$3,'text',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)", input.RequestID, u.ID, input.ModelID, input.Content, jsonBytes(parameters), price, pricingKind, inputPrice, cachedPrice, outputPrice, discount.String(), digest, conversationID, messageID, model["name"], model["displayName"], moderationID, status, settings.MaxAttempts); err != nil {
				return err
			}
			_, err = tx.Exec(ctx, "UPDATE conversations SET updated_at=now() WHERE id=$1", conversationID)
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
	task, err := one(ctx, a.DB, "SELECT id,conversation_id,response_message_id,status,error_code,error_message,partial_text,stream_sequence,run,attempt_count,max_attempts,prompt_tokens,cached_tokens,completion_tokens,billed_micros,price_micros,queued_at AS created_at,finished_at FROM generation_tasks WHERE id=$1 AND user_id=$2 AND capability='text'", id, currentUser(c).ID)
	if err != nil {
		return nil, err
	}
	var message Row
	task["billed"], task["price"] = money(integer(task["billedMicros"])), money(integer(task["priceMicros"]))
	delete(task, "billedMicros")
	delete(task, "priceMicros")
	if task["responseMessageId"] != nil {
		message, err = one(ctx, a.DB, "SELECT id,role,content,created_at FROM messages WHERE id=$1", task["responseMessageId"])
	}
	return gin.H{"request": task, "message": message}, err
}
