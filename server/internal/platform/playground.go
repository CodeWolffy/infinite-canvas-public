package platform

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"

	"github.com/gabriel-vasile/mimetype"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type upstreamTraceKey struct{}

type upstreamTrace struct {
	status       int
	firstTokenMS *int64
	rawResponse  any
	started      time.Time
	secret       string
}

func traceFrom(ctx context.Context) *upstreamTrace {
	trace, _ := ctx.Value(upstreamTraceKey{}).(*upstreamTrace)
	return trace
}

func (t *upstreamTrace) redact(value string) string {
	if t.secret != "" {
		value = strings.ReplaceAll(value, t.secret, "[REDACTED]")
		encoded, _ := json.Marshal(t.secret)
		return strings.ReplaceAll(value, string(encoded[1:len(encoded)-1]), "[REDACTED]")
	}
	return value
}

func (t *upstreamTrace) payload(raw string) any {
	raw = t.redact(raw)
	if json.Valid([]byte(raw)) {
		return json.RawMessage(raw)
	}
	return raw
}

func (a *App) playgroundTest(c *gin.Context) (any, error) {
	input, err := body[struct {
		ChannelID  string         `json:"channelId" binding:"required,uuid"`
		Model      string         `json:"model" binding:"required"`
		Capability string         `json:"capability" binding:"omitempty,oneof=text image"`
		Prompt     string         `json:"prompt" binding:"required"`
		Parameters map[string]any `json:"parameters"`
	}](c)
	if err != nil {
		return nil, err
	}
	input.Model, input.Prompt = strings.TrimSpace(input.Model), strings.TrimSpace(input.Prompt)
	if input.Model == "" || input.Prompt == "" {
		return nil, problem(400, "invalid_probe", "请输入模型名称和测试提示词")
	}
	if input.Capability == "" {
		input.Capability = "text"
	}
	ctx := c.Request.Context()
	row, err := one(ctx, a.DB, "SELECT * FROM channels WHERE id=$1 AND deleted_at IS NULL", input.ChannelID)
	if err != nil {
		return nil, err
	}
	if row["capability"] != input.Capability {
		return nil, problem(400, "invalid_capability", "请选择与调试类型一致的渠道")
	}
	ch, err := a.channelFromRow(row)
	if err != nil {
		return nil, err
	}
	ch.UpstreamModel = input.Model
	if ch.Protocol == "anthropic" && input.Capability == "text" && explicitTextTokens(input.Parameters) == 0 {
		return nil, problem(400, "output_limit_required", "Claude Messages 必须填写最大输出 token 数")
	}
	task := Row{"id": uuid.NewString(), "run": 1, "probe": true, "userId": currentUser(c).ID, "note": "渠道在线调试", "capability": input.Capability, "prompt": input.Prompt, "parameters": input.Parameters}
	bindings, err := rows(ctx, a.DB, "SELECT b.id,b.model_id,b.cost_config FROM model_channels b JOIN models m ON m.id=b.model_id WHERE b.channel_id=$1 AND b.upstream_model=$2 AND m.capability=$3 AND m.deleted_at IS NULL", ch.ID, ch.UpstreamModel, input.Capability)
	if err != nil {
		return nil, err
	}
	if len(bindings) == 1 {
		task["modelId"], ch.CostConfig = bindings[0]["modelId"], object(bindings[0]["costConfig"])
		ch.BindingID = str(bindings[0]["id"])
	}
	// 排队期间跟随请求取消；拿到共享槽位后才开始计算渠道执行超时。
	var deadline time.Time
	for {
		state, err := one(ctx, a.DB, "SELECT status,cooldown_until FROM channels WHERE id=$1 AND deleted_at IS NULL", ch.ID)
		if err != nil {
			return nil, err
		}
		if state["status"] != "active" {
			return nil, problem(409, "channel_disabled", "请先启用渠道")
		}
		cooldown, _ := state["cooldownUntil"].(time.Time)
		if !time.Now().Before(cooldown) {
			deadline = time.Now().Add(time.Duration(ch.TimeoutMS) * time.Millisecond)
			acquired, err := a.slot(ctx, ch, task, deadline)
			if err != nil {
				return nil, err
			}
			if acquired {
				break
			}
		}
		timer := time.NewTimer(queuePoll)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	defer a.releaseSlot(ch, task)
	if err = a.selectChannelKey(ctx, &ch, nil, true); err != nil {
		return nil, err
	}
	testCtx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	trace := &upstreamTrace{secret: ch.APIKey}
	testCtx = context.WithValue(testCtx, upstreamTraceKey{}, trace)
	started := time.Now()
	result, err := a.runProbe(testCtx, ch, task)
	response := gin.H{"ok": err == nil, "durationMs": time.Since(started).Milliseconds(), "capability": input.Capability, "upstreamModel": ch.UpstreamModel, "httpStatus": trace.status, "firstTokenMs": trace.firstTokenMS, "rawResponse": trace.rawResponse}
	if err != nil {
		response["error"], response["category"] = trace.redact(err.Error()), classify(err).Category
	} else {
		response["text"], response["outputTokens"] = trace.redact(result.Text), result.CompletionTokens
		if len(result.Data) > 0 {
			response["image"] = "data:" + mimetype.Detect(result.Data).String() + ";base64," + base64.StdEncoding.EncodeToString(result.Data)
		}
	}
	return response, nil
}
