package platform

import (
	"context"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
	"github.com/tiktoken-go/tokenizer"
)

func roundedMicros(value decimal.Decimal) (int64, error) {
	n, err := strconv.ParseInt(value.Ceil().StringFixed(0), 10, 64)
	if err != nil || n < 0 {
		return 0, problem(400, "invalid_price", "金额超出允许范围")
	}
	return n, nil
}

// paramSeconds 统一读取计费时长：seconds 与 durationSeconds 是同义别名，冲突时拒绝请求。
func paramSeconds(params map[string]any) (decimal.Decimal, error) {
	seconds := decimal.Zero
	if value := params["seconds"]; value != nil && value != "" {
		parsed, err := boundedDecimal(str(value), 131072, 16383)
		if err != nil || !parsed.IsPositive() {
			return parsed, problem(400, "invalid_duration", "生成时长必须为正数")
		}
		seconds = parsed
	}
	if value := params["durationSeconds"]; value != nil && value != "" {
		parsed, err := boundedDecimal(str(value), 131072, 16383)
		if err != nil || !parsed.IsPositive() {
			return parsed, problem(400, "invalid_duration", "生成时长必须为正数")
		}
		if !seconds.IsZero() && !seconds.Equal(parsed) {
			return seconds, problem(400, "invalid_duration", "生成时长参数不一致，请只提供 seconds")
		}
		seconds = parsed
	}
	return seconds, nil
}

// 创建、重试和预报价使用相同的价格快照，零单价与未配置分别处理。
func pricingSnapshot(model Row, discount decimal.Decimal, params map[string]any, promptEstimate int64) (Row, error) {
	if model["capability"] == "audio" && model["pricePerSecond"] != nil {
		return nil, problem(400, "audio_duration_unbounded", "按秒计价音频暂不可用，请联系管理员改为固定单次价")
	}
	p := Row{"pricingKind": "fixed", "groupDiscount": discount.String(), "seconds": nil}
	for _, field := range []string{"priceMicros", "inputPricePerMillion", "cachedPricePerMillion", "outputPricePerMillion", "pricePerSecond"} {
		p[field] = nil
		if model[field] != nil {
			value, err := roundedMicros(decimal.NewFromInt(integer(model[field])).Mul(discount))
			if err != nil {
				return nil, err
			}
			p[field] = value
		}
	}
	hold := integer(p["priceMicros"])
	p["unitPriceMicros"] = hold
	if model["capability"] == "text" && p["inputPricePerMillion"] != nil {
		p["pricingKind"] = "token"
		if p["cachedPricePerMillion"] == nil {
			p["cachedPricePerMillion"] = p["inputPricePerMillion"]
		}
		output := explicitTextTokens(params)
		estimate, err := tokenCost(promptEstimate, 0, output, integer(p["inputPricePerMillion"]), integer(p["cachedPricePerMillion"]), integer(p["outputPricePerMillion"]))
		if err != nil {
			return nil, err
		}
		hold = max(hold, estimate)
	} else if p["pricePerSecond"] != nil && (model["capability"] == "video" || model["capability"] == "audio") {
		seconds := decimal.NewFromInt(5)
		if params["seconds"] != nil || params["durationSeconds"] != nil {
			var err error
			seconds, err = paramSeconds(params)
			if err != nil {
				return nil, err
			}
		}
		p["seconds"] = seconds.String()
		value, err := roundedMicros(seconds.Mul(decimal.NewFromInt(integer(p["pricePerSecond"]))))
		if err != nil {
			return nil, err
		}
		hold = max(hold, value)
	}
	p["priceMicros"] = hold
	return p, nil
}

func promptEstimate(ctx context.Context, q querier, conversation, content, system string, attachments ...string) (int64, error) {
	return promptEstimateBefore(ctx, q, conversation, content, system, 0, attachments...)
}

func promptEstimateBefore(ctx context.Context, q querier, conversation, content, system string, before int64, attachments ...string) (int64, error) {
	var history, images int64
	if conversation != "" {
		if err := q.QueryRow(ctx, "SELECT coalesce(sum(octet_length(m.content)),0) FROM messages m WHERE m.conversation_id=$1 AND ($2::bigint=0 OR m.sequence<$2) AND "+approvedMessage, conversation, before).Scan(&history); err != nil {
			return 0, err
		}
		// 图片按传给上游的 base64 字节预算，历史附件也计入；实际用量仍以结算为准。
		if err := q.QueryRow(ctx, `SELECT coalesce(sum(4*((o.byte_size+2)/3)),0) FROM media_objects o
			JOIN media_references r ON r.media_id=o.id JOIN messages m ON r.owner_kind='message' AND r.owner_id=m.id
			WHERE m.conversation_id=$1 AND ($2::bigint=0 OR m.sequence<$2) AND `+approvedMessage, conversation, before).Scan(&images); err != nil {
			return 0, err
		}
	}
	var incoming int64
	if len(attachments) > 0 {
		if err := q.QueryRow(ctx, "SELECT coalesce(sum(4*((byte_size+2)/3)),0) FROM media_objects WHERE id=ANY($1::uuid[])", attachments).Scan(&incoming); err != nil {
			return 0, err
		}
	}
	// 不再假定所有文字都能按每 token 四字节压缩；沿用既有 1024 的消息开销预算。
	return history + int64(len(content)+len(system)) + images + incoming + 1024, nil
}

func textContextSummary(ctx context.Context, q querier, model Row, input textInput, before int64) (Row, error) {
	history := []Row{}
	var count int
	var images int64
	if input.ConversationID != "" {
		if err := q.QueryRow(ctx, `SELECT count(*),coalesce(sum((SELECT count(*) FROM media_references r WHERE r.owner_kind='message' AND r.owner_id=m.id)),0)::bigint
			FROM messages m WHERE m.conversation_id=$1 AND ($2::bigint=0 OR m.sequence<$2) AND `+approvedMessage, input.ConversationID, before).Scan(&count, &images); err != nil {
			return nil, err
		}
		if integer(object(model["config"])["contextWindowTokens"]) > 0 && images == 0 && len(input.AttachmentMediaIDs) == 0 {
			var err error
			history, err = rows(ctx, q, "SELECT m.content FROM messages m WHERE m.conversation_id=$1 AND ($2::bigint=0 OR m.sequence<$2) AND "+approvedMessage+" ORDER BY m.sequence", input.ConversationID, before)
			if err != nil {
				return nil, err
			}
		}
	}
	if input.Content != "" || len(input.AttachmentMediaIDs) > 0 {
		count++
	}
	return summarizeTextContext(model, history, input, count, images+int64(len(input.AttachmentMediaIDs)))
}

var contextTokenizer = sync.OnceValues(func() (tokenizer.Codec, error) {
	return tokenizer.Get(tokenizer.Cl100kBase)
})

func summarizeTextContext(model Row, history []Row, input textInput, count int, images int64) (Row, error) {
	result := Row{"messageCount": count, "imageCount": images, "estimatedTokens": nil, "contextWindow": nil}
	capacity := integer(object(model["config"])["contextWindowTokens"])
	if capacity == 0 {
		result["estimateNote"] = "管理员尚未配置模型上下文容量，当前仅显示本次有效上下文的消息与图片数量。"
		return result, nil
	}
	result["contextWindow"] = capacity
	if images > 0 {
		result["estimateNote"] = "本次上下文包含图片，不同模型的图片用量规则不同，暂不估算 token 数。"
		return result, nil
	}
	codec, err := contextTokenizer()
	if err != nil {
		return nil, err
	}
	var tokens int64
	texts := []string{input.Content, input.SystemPrompt}
	for _, message := range history {
		texts = append(texts, str(message["content"]))
	}
	for _, content := range texts {
		value, err := codec.Count(content)
		if err != nil {
			return nil, err
		}
		tokens += int64(value)
	}
	result["estimatedTokens"] = tokens
	result["estimateNote"] = "使用 cl100k_base 对有效历史、当前输入和系统提示词做文本估计，未包含协议封装；不同模型实际用量可能不同。"
	if tokens > capacity-explicitTextTokens(input.Parameters) {
		result["warning"] = "预估上下文加生成预算可能超过模型容量，可新建对话或调整输入；仍可发送，不会自动裁剪历史。"
	}
	return result, nil
}

func (a *App) quoteRoutes(api *gin.RouterGroup) {
	api.POST("/generation-quote", a.rateLimit("quote", 120, time.Minute), respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			ModelID            string         `json:"modelId" binding:"required,uuid"`
			Count              int            `json:"count" binding:"required,min=1,max=20"`
			Content            string         `json:"content"`
			System             string         `json:"systemPrompt"`
			ConversationID     string         `json:"conversationId" binding:"omitempty,uuid"`
			AttachmentMediaIDs []string       `json:"attachmentMediaIds" binding:"max=20,dive,uuid"`
			Parameters         map[string]any `json:"parameters"`
			Action             string         `json:"action" binding:"omitempty,oneof=edit regenerate"`
			TargetMessageID    string         `json:"targetMessageId" binding:"omitempty,uuid"`
		}](c)
		if err != nil {
			return nil, err
		}
		ctx, u := c.Request.Context(), currentUser(c)
		if err = a.modelAccess(ctx, a.DB, u.ID, input.ModelID); err != nil {
			return nil, err
		}
		model, err := one(ctx, a.DB, "SELECT * FROM models WHERE id=$1 AND status='published' AND deleted_at IS NULL", input.ModelID)
		if err != nil {
			return nil, err
		}
		if model["capability"] == "text" {
			input.Parameters, err = modelTextParameters(model, input.Parameters)
			if err != nil {
				return nil, err
			}
		}
		if input.ConversationID != "" {
			if _, err = one(ctx, a.DB, "SELECT id FROM conversations WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL", input.ConversationID, u.ID); err != nil {
				return nil, err
			}
		}
		text := textInput{ConversationID: input.ConversationID, Content: input.Content, SystemPrompt: input.System, AttachmentMediaIDs: input.AttachmentMediaIDs, Parameters: input.Parameters, Action: input.Action, TargetMessageID: input.TargetMessageID}
		var before int64
		if model["capability"] == "text" {
			before, err = resolveTextRevision(ctx, a.DB, input.ConversationID, &text)
			if err != nil {
				return nil, err
			}
			input.Content, input.AttachmentMediaIDs = text.Content, text.AttachmentMediaIDs
		} else if input.Action != "" || input.TargetMessageID != "" {
			return nil, problem(400, "invalid_text_action", "只有文本对话支持编辑和重新生成")
		}
		if len(input.AttachmentMediaIDs) > 0 {
			var visible int
			if err = a.DB.QueryRow(ctx, "SELECT count(DISTINCT m.id) FROM media_objects m WHERE m.id=ANY($1::uuid[]) AND m.status='ready' AND "+mediaVisibility, input.AttachmentMediaIDs, u.ID, false).Scan(&visible); err != nil {
				return nil, err
			}
			if visible != len(input.AttachmentMediaIDs) {
				return nil, problem(400, "invalid_media", "包含重复、无权访问或不可用的文件")
			}
		}
		var contextSummary Row
		if model["capability"] == "text" {
			if err = validateTextImages(ctx, a.DB, model, input.ConversationID, before, input.AttachmentMediaIDs); err != nil {
				return nil, err
			}
			contextSummary, err = textContextSummary(ctx, a.DB, model, text, before)
			if err != nil {
				return nil, err
			}
		}
		estimate, err := promptEstimateBefore(ctx, a.DB, input.ConversationID, input.Content, input.System, before, input.AttachmentMediaIDs...)
		if err != nil {
			return nil, err
		}
		discount, err := a.groupDiscount(ctx, a.DB, &u)
		if err != nil {
			return nil, err
		}
		p, err := pricingSnapshot(model, discount, input.Parameters, estimate)
		if err != nil {
			return nil, err
		}
		if model["capability"] == "text" {
			input.Count = 1
		}
		total, err := roundedMicros(decimal.NewFromInt(integer(p["priceMicros"])).Mul(decimal.NewFromInt(int64(input.Count))))
		if err != nil {
			return nil, err
		}
		result := gin.H{"quote": gin.H{"pricingKind": p["pricingKind"], "estimatedHold": modelPrice(total), "unitHold": modelPrice(integer(p["priceMicros"])), "seconds": p["seconds"], "groupDiscount": p["groupDiscount"], "variable": p["pricingKind"] == "token" || p["pricePerSecond"] != nil}}
		if contextSummary != nil {
			result["context"] = contextSummary
		}
		return result, nil
	}))
}
