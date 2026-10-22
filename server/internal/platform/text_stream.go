package platform

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/tmaxmax/go-sse"
)

// 流式文本按半秒合并落库，兼顾流式手感与写入次数；会话状态仍由事件推送，不必每个心跳都查库。
const (
	textFlushInterval   = 500 * time.Millisecond
	textSessionInterval = 30 * time.Second
	// streamWriteTimeout 是单次写 SSE 的超时：客户端不读取时写入会一直阻塞，
	// 必须由写超时断开，否则 goroutine、ticker 与订阅者会被永久占用。
	streamWriteTimeout = 30 * time.Second
	maxStreamsPerUser  = 4
)

// acquireStream/releaseStream 限制单个用户的并发实时连接数。
func (a *App) acquireStream(userID string) bool {
	a.streamMu.Lock()
	defer a.streamMu.Unlock()
	if a.streamUsers == nil {
		a.streamUsers = map[string]int{}
	}
	if a.streamUsers[userID] >= maxStreamsPerUser {
		return false
	}
	a.streamUsers[userID]++
	return true
}

func (a *App) releaseStream(userID string) {
	a.streamMu.Lock()
	defer a.streamMu.Unlock()
	if a.streamUsers[userID] <= 1 {
		delete(a.streamUsers, userID)
		return
	}
	a.streamUsers[userID]--
}

func (a *App) wakeText(id string) {
	a.streamMu.Lock()
	defer a.streamMu.Unlock()
	for ch := range a.streamSinks[id] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func (a *App) publishText(ctx context.Context, id string) {
	a.wakeText(id)
	if a.Redis != nil {
		_ = a.Redis.Publish(ctx, "ic:text-events", id).Err()
	}
}

// cancelRunning 中断本实例中该任务的上游请求；没有在跑的任务时是空操作。
func (a *App) cancelRunning(id string) {
	if cancel, ok := a.running.Load(id); ok {
		if fn, ok := cancel.(context.CancelFunc); ok {
			fn()
		}
	}
}

// publishCancel 本地中断后经 Redis 广播，让其他实例也停掉同一个任务的上游请求。
func (a *App) publishCancel(ctx context.Context, id string) {
	a.cancelRunning(id)
	if a.Redis != nil {
		_ = a.Redis.Publish(ctx, "ic:task-cancel", id).Err()
	}
}

func (a *App) startCancelEvents(ctx context.Context) {
	a.workers.Add(1)
	go func() {
		defer a.workers.Done()
		if a.Redis == nil {
			return
		}
		sub := a.Redis.Subscribe(ctx, "ic:task-cancel")
		defer sub.Close()
		messages := sub.Channel()
		for {
			select {
			case <-ctx.Done():
				return
			case message, ok := <-messages:
				if !ok {
					return
				}
				a.cancelRunning(message.Payload)
			}
		}
	}()
}

func (a *App) startTextEvents(ctx context.Context) {
	a.workers.Add(1)
	go func() {
		defer a.workers.Done()
		if a.Redis == nil {
			return
		}
		sub := a.Redis.Subscribe(ctx, "ic:text-events")
		defer sub.Close()
		messages := sub.Channel()
		for {
			select {
			case <-ctx.Done():
				return
			case message, ok := <-messages:
				if !ok {
					return
				}
				a.wakeText(message.Payload)
			}
		}
	}()
}

func (a *App) appendText(ctx context.Context, task Row, delta string) error {
	if delta == "" || task["probe"] == true {
		return nil
	}
	result, err := a.DB.Exec(ctx, "UPDATE generation_tasks SET partial_text=partial_text||$4,stream_sequence=stream_sequence+1,first_token_at=coalesce(first_token_at,now()) WHERE id=$1 AND worker_token=$2 AND run=$3 AND status='running'", task["id"], task["workerToken"], task["run"], delta)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return context.Canceled
	}
	a.publishText(ctx, str(task["id"]))
	return nil
}

func (a *App) textEvents(c *gin.Context) {
	id, err := idParam(c, "id")
	if err != nil {
		fail(c, err)
		return
	}
	if _, err = a.textRequestDetail(c); err != nil {
		fail(c, err)
		return
	}
	u := currentUser(c)
	if !a.acquireStream(u.ID) {
		fail(c, problem(429, "too_many_streams", "同时打开的实时连接过多，请稍后重试"))
		return
	}
	defer a.releaseStream(u.ID)
	changed := a.addSink(id)
	defer a.removeSink(id, changed)
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-store")
	c.Header("X-Accel-Buffering", "no")
	controller := http.NewResponseController(c.Writer)
	arm := func() { _ = controller.SetWriteDeadline(time.Now().Add(streamWriteTimeout)) }
	ticker := time.NewTicker(queuePoll)
	defer ticker.Stop()
	last := ""
	var lastSessionCheck time.Time
	// 只在首次连接和收到 changed 信号时查库；心跳 tick 仅保活连接。
	// 会话校验每 30 秒执行一次，顺带强制刷新一次快照，作为 Redis 丢消息时的兜底。
	refresh := true
	for {
		if time.Since(lastSessionCheck) >= textSessionInterval {
			if _, err := a.loadUser(c); err != nil {
				arm()
				c.SSEvent("expired", gin.H{})
				_ = controller.Flush()
				return
			}
			lastSessionCheck = time.Now()
			refresh = true
		}
		if refresh {
			refresh = false
			value, err := a.textRequestDetail(c)
			if err != nil {
				arm()
				c.SSEvent("unavailable", gin.H{})
				_ = controller.Flush()
				return
			}
			detail := value.(gin.H)
			request := detail["request"].(Row)
			key := str(request["run"]) + ":" + str(request["streamSequence"]) + ":" + str(request["status"]) + ":" + str(request["attemptCount"]) + ":" + str(request["canCancel"])
			if key != last {
				arm()
				c.SSEvent("snapshot", value)
				last = key
			}
			if controller.Flush() != nil {
				return
			}
			if request["status"] != "reviewing" && request["status"] != "running" && request["status"] != "queued" {
				return
			}
		}
		select {
		case <-c.Request.Context().Done():
			return
		case <-a.shutdown:
			return
		case <-changed:
			refresh = true
		case <-ticker.C:
			arm()
			if _, err := c.Writer.Write([]byte(": ping\n\n")); err != nil || controller.Flush() != nil {
				return
			}
		}
	}
}

type openAITokenDetails struct {
	CachedTokens *int64 `json:"cached_tokens"`
}

type openAIUsage struct {
	PromptTokens        *int64              `json:"prompt_tokens"`
	InputTokens         *int64              `json:"input_tokens"`
	CompletionTokens    *int64              `json:"completion_tokens"`
	OutputTokens        *int64              `json:"output_tokens"`
	PromptTokensDetails *openAITokenDetails `json:"prompt_tokens_details"`
	InputTokensDetails  *openAITokenDetails `json:"input_tokens_details"`
}

func (usage openAIUsage) apply(result *generationResult) {
	if usage.PromptTokens != nil {
		result.PromptTokens = *usage.PromptTokens
	}
	if usage.InputTokens != nil {
		result.PromptTokens = *usage.InputTokens
	}
	if usage.CompletionTokens != nil {
		result.CompletionTokens = *usage.CompletionTokens
	}
	if usage.OutputTokens != nil {
		result.CompletionTokens = *usage.OutputTokens
	}
	if usage.PromptTokensDetails != nil && usage.PromptTokensDetails.CachedTokens != nil {
		result.CachedTokens = *usage.PromptTokensDetails.CachedTokens
	}
	if usage.InputTokensDetails != nil && usage.InputTokensDetails.CachedTokens != nil {
		result.CachedTokens = *usage.InputTokensDetails.CachedTokens
	}
}

func (a *App) streamText(ctx context.Context, req *http.Request, channel channel, task Row) (generationResult, error) {
	trace := traceFrom(ctx)
	if trace != nil {
		trace.started = time.Now()
	}
	response, err := safeClient(a.Config.AllowPrivateHosts).Do(req)
	if err != nil {
		return generationResult{}, err
	}
	defer response.Body.Close()
	if trace != nil {
		trace.status = response.StatusCode
	}
	reader := io.LimitReader(response.Body, a.Config.MaxGenerated*2+1)
	if response.StatusCode >= 300 {
		raw, _ := io.ReadAll(reader)
		if trace != nil {
			trace.rawResponse = trace.payload(string(raw))
		}
		var payload map[string]any
		_ = json.Unmarshal(raw, &payload)
		return generationResult{}, responseError(response.StatusCode, payload, string(raw), channel.APIKey)
	}
	result := generationResult{}
	var content, pending strings.Builder
	var lastFlush time.Time
	flush := func() error {
		if pending.Len() == 0 {
			return nil
		}
		if err := a.appendText(ctx, task, pending.String()); err != nil {
			return err
		}
		pending.Reset()
		lastFlush = time.Now()
		return nil
	}
	finished := false
	consume := func(payload map[string]any, stream bool) error {
		if payload["error"] != nil {
			return responseError(400, payload, "", channel.APIKey)
		}
		delta := ""
		if channel.Protocol == "gemini" {
			if str(object(payload["promptFeedback"])["blockReason"]) != "" {
				return &upstreamError{Category: "content_policy"}
			}
			candidates, _ := payload["candidates"].([]any)
			if len(candidates) > 0 {
				candidate := object(candidates[0])
				finish := str(candidate["finishReason"])
				if finish != "" && finish != "STOP" && finish != "MAX_TOKENS" {
					return &upstreamError{Category: "content_policy"}
				}
				finished = finished || finish != ""
				parts, _ := object(candidate["content"])["parts"].([]any)
				for _, part := range parts {
					p := object(part)
					if p["thought"] != true {
						delta += str(p["text"])
					}
				}
			}
			if usage := object(payload["usageMetadata"]); len(usage) > 0 {
				result.PromptTokens = integer(usage["promptTokenCount"])
				result.CachedTokens = integer(usage["cachedContentTokenCount"])
				result.CompletionTokens = integer(usage["candidatesTokenCount"]) + integer(usage["thoughtsTokenCount"])
			}
		} else if channel.Protocol == "anthropic" {
			var done bool
			var err error
			delta, done, err = anthropicEvent(payload, stream, &result)
			if err != nil {
				return err
			}
			finished = finished || done
		} else {
			eventType := str(payload["type"])
			if eventType == "response.output_text.delta" {
				delta = str(payload["delta"])
			} else if eventType == "response.output_text.done" {
				if delta == "" && content.Len() == 0 {
					delta = str(payload["text"])
				}
			} else if eventType == "response.completed" || eventType == "response.done" {
				finished = true
			} else if outText := str(payload["output_text"]); outText != "" && !stream {
				delta = outText
				finished = true
			}
			choices, _ := payload["choices"].([]any)
			if len(choices) > 0 {
				choice := object(choices[0])
				message := object(choice["message"])
				if stream {
					message = object(choice["delta"])
				}
				if str(message["refusal"]) != "" || choice["finish_reason"] == "content_filter" {
					return &upstreamError{Category: "content_policy"}
				}
				delta = str(message["content"])
				finished = finished || str(choice["finish_reason"]) != ""
			}
			usage := object(payload["usage"])
			if len(usage) == 0 {
				usage = object(object(payload["response"])["usage"])
			}
			if len(usage) > 0 {
				var value openAIUsage
				if err := json.Unmarshal(jsonBytes(usage), &value); err != nil {
					return err
				}
				// usage 可能分帧到达，缺失字段不能把已收到的输入量或缓存量清零。
				value.apply(&result)
			}
		}
		if int64(content.Len()+len(delta)) > a.Config.MaxGenerated*2 {
			return errors.New("文本结果超过现有大小限制")
		}
		if trace != nil && trace.firstTokenMS == nil && delta != "" {
			elapsed := time.Since(trace.started).Milliseconds()
			trace.firstTokenMS = &elapsed
		}
		content.WriteString(delta)
		pending.WriteString(delta)
		// 首段立即保存；后续按半秒合并写入，避免逐 token 更新大字段。
		if lastFlush.IsZero() || time.Since(lastFlush) >= textFlushInterval {
			return flush()
		}
		return nil
	}
	if strings.Contains(response.Header.Get("Content-Type"), "text/event-stream") {
		if trace != nil {
			trace.rawResponse = []any{}
		}
		for event, err := range sse.Read(reader, &sse.ReadConfig{MaxEventSize: int(a.Config.MaxGenerated * 2)}) {
			if err != nil {
				return generationResult{}, err
			}
			if trace != nil && event.Data != "" {
				trace.rawResponse = append(trace.rawResponse.([]any), trace.payload(event.Data))
			}
			if event.Data == "[DONE]" {
				finished = true
				break
			}
			if event.Data == "" {
				continue
			}
			var payload map[string]any
			decoder := json.NewDecoder(strings.NewReader(event.Data))
			decoder.UseNumber()
			if err = decoder.Decode(&payload); err != nil {
				return generationResult{}, err
			}
			if err = consume(payload, true); err != nil {
				return generationResult{}, err
			}
		}
	} else {
		var payload map[string]any
		decoder := json.NewDecoder(reader)
		decoder.UseNumber()
		if err = decoder.Decode(&payload); err != nil {
			return generationResult{}, err
		}
		if trace != nil {
			trace.rawResponse = trace.payload(string(jsonBytes(payload)))
		}
		if err = consume(payload, false); err != nil {
			return generationResult{}, err
		}
		finished = true
	}
	result.Text = content.String()
	if !finished || strings.TrimSpace(result.Text) == "" {
		return generationResult{}, &upstreamError{Category: "stream_interrupted", Retryable: content.Len() == 0}
	}
	if err = flush(); err != nil {
		return generationResult{}, err
	}
	return result, nil
}
