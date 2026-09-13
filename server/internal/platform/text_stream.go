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
	changed := make(chan struct{}, 1)
	a.streamMu.Lock()
	if a.streamSinks == nil {
		a.streamSinks = map[string]map[chan struct{}]struct{}{}
	}
	if a.streamSinks[id] == nil {
		a.streamSinks[id] = map[chan struct{}]struct{}{}
	}
	a.streamSinks[id][changed] = struct{}{}
	a.streamMu.Unlock()
	defer func() {
		a.streamMu.Lock()
		delete(a.streamSinks[id], changed)
		if len(a.streamSinks[id]) == 0 {
			delete(a.streamSinks, id)
		}
		a.streamMu.Unlock()
	}()
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-store")
	c.Header("X-Accel-Buffering", "no")
	ticker := time.NewTicker(queuePoll)
	defer ticker.Stop()
	last := ""
	for {
		if _, err := a.loadUser(c); err != nil {
			c.SSEvent("expired", gin.H{})
			c.Writer.Flush()
			return
		}
		value, err := a.textRequestDetail(c)
		if err != nil {
			c.SSEvent("unavailable", gin.H{})
			c.Writer.Flush()
			return
		}
		detail := value.(gin.H)
		request := detail["request"].(Row)
		key := str(request["run"]) + ":" + str(request["streamSequence"]) + ":" + str(request["status"]) + ":" + str(request["attemptCount"])
		if key != last {
			c.SSEvent("snapshot", value)
			last = key
		} else {
			_, _ = c.Writer.Write([]byte(": heartbeat\n\n"))
		}
		c.Writer.Flush()
		if request["status"] != "reviewing" && request["status"] != "running" && request["status"] != "queued" {
			return
		}
		select {
		case <-c.Request.Context().Done():
			return
		case <-a.shutdown:
			return
		case <-changed:
		case <-ticker.C:
		}
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
			if usage := object(payload["usage"]); len(usage) > 0 {
				result.PromptTokens = integer(usage["prompt_tokens"])
				result.CachedTokens = integer(object(usage["prompt_tokens_details"])["cached_tokens"])
				result.CompletionTokens = integer(usage["completion_tokens"])
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
		// 首段立即保存；后续沿用任务轮询节奏合并写入，避免逐 token 更新大字段。
		if lastFlush.IsZero() || time.Since(lastFlush) >= queuePoll {
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
