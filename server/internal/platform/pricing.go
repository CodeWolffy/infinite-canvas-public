package platform

import (
	"context"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
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
		parsed, err := decimal.NewFromString(str(value))
		if err != nil || !parsed.IsPositive() {
			return parsed, problem(400, "invalid_duration", "生成时长必须为正数")
		}
		seconds = parsed
	}
	if value := params["durationSeconds"]; value != nil && value != "" {
		parsed, err := decimal.NewFromString(str(value))
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
		output := integer(params["max_completion_tokens"])
		if output <= 0 {
			output = integer(params["max_tokens"])
		}
		if output <= 0 {
			output = integer(params["maxOutputTokens"])
		}
		if output <= 0 {
			output = 4096
		}
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

func promptEstimate(ctx context.Context, q querier, conversation, content, system string) (int64, error) {
	var history int64
	if conversation != "" {
		if err := q.QueryRow(ctx, "SELECT coalesce(sum(octet_length(m.content)),0) FROM messages m WHERE m.conversation_id=$1 AND "+approvedMessage, conversation).Scan(&history); err != nil {
			return 0, err
		}
	}
	return (history + int64(len(content)+len(system)) + 1024) / 4, nil
}

func (a *App) quoteRoutes(api *gin.RouterGroup) {
	api.POST("/generation-quote", respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			ModelID        string         `json:"modelId" binding:"required,uuid"`
			Count          int            `json:"count" binding:"required,min=1,max=20"`
			Content        string         `json:"content"`
			System         string         `json:"systemPrompt"`
			ConversationID string         `json:"conversationId" binding:"omitempty,uuid"`
			Parameters     map[string]any `json:"parameters"`
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
		if input.ConversationID != "" {
			if _, err = one(ctx, a.DB, "SELECT id FROM conversations WHERE id=$1 AND user_id=$2", input.ConversationID, u.ID); err != nil {
				return nil, err
			}
		}
		estimate, err := promptEstimate(ctx, a.DB, input.ConversationID, input.Content, input.System)
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
		return gin.H{"quote": gin.H{"pricingKind": p["pricingKind"], "estimatedHold": money(total), "unitHold": money(integer(p["priceMicros"])), "seconds": p["seconds"], "groupDiscount": p["groupDiscount"], "variable": p["pricingKind"] == "token" || p["pricePerSecond"] != nil}}, nil
	}))
}
