package platform

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// taskEventsTopic 广播非文本任务的状态变化；SSE 订阅者被唤醒后重新读取数据库快照，事件本身不携带任务内容。
const taskEventsTopic = "ic:task-events"

func (a *App) addSink(id string) chan struct{} {
	ch := make(chan struct{}, 1)
	a.streamMu.Lock()
	if a.streamSinks == nil {
		a.streamSinks = map[string]map[chan struct{}]struct{}{}
	}
	if a.streamSinks[id] == nil {
		a.streamSinks[id] = map[chan struct{}]struct{}{}
	}
	a.streamSinks[id][ch] = struct{}{}
	a.streamMu.Unlock()
	return ch
}

func (a *App) removeSink(id string, ch chan struct{}) {
	a.streamMu.Lock()
	if set := a.streamSinks[id]; set != nil {
		delete(set, ch)
		if len(set) == 0 {
			delete(a.streamSinks, id)
		}
	}
	a.streamMu.Unlock()
}

// publishTaskChange 在任务状态落库后唤醒订阅者：文本任务走对话流，其余按所属批次推送。
func (a *App) publishTaskChange(ctx context.Context, task Row) {
	if task["capability"] == "text" {
		a.publishText(ctx, str(task["id"]))
		return
	}
	if id := str(task["batchId"]); id != "" {
		a.publishBatchEvent(ctx, id)
	}
}

func (a *App) publishBatchEvent(ctx context.Context, id string) {
	a.wakeText(id)
	if a.Redis != nil {
		_ = a.Redis.Publish(ctx, taskEventsTopic, id).Err()
	}
}

// startTaskEvents 跨实例转发批次事件；Redis 丢消息时由 SSE 端的周期会话校验兜底刷新。
func (a *App) startTaskEvents(ctx context.Context) {
	a.workers.Add(1)
	go func() {
		defer a.workers.Done()
		if a.Redis == nil {
			return
		}
		sub := a.Redis.Subscribe(ctx, taskEventsTopic)
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

// batchEvents 为图片/视频/音频批次提供 SSE：有状态变化时推送完整快照，全部任务进入终态后关闭。
func (a *App) batchEvents(c *gin.Context) {
	id, err := idParam(c, "id")
	if err != nil {
		fail(c, err)
		return
	}
	ctx := c.Request.Context()
	u := currentUser(c)
	if _, err = one(ctx, a.DB, "SELECT id FROM generation_batches WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL", id, u.ID); err != nil {
		fail(c, err)
		return
	}
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
	var lastSessionCheck time.Time
	// 与文本流一致：只在唤醒和 30 秒周期校验时查库，心跳仅保活连接。
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
			value, err := a.batchDetail(ctx, id, u.ID)
			if err != nil {
				arm()
				c.SSEvent("unavailable", gin.H{})
				_ = controller.Flush()
				return
			}
			arm()
			c.SSEvent("snapshot", value)
			if controller.Flush() != nil {
				return
			}
			done := true
			for _, task := range value.(gin.H)["tasks"].([]Row) {
				status := str(task["status"])
				if status == "reviewing" || status == "queued" || status == "running" {
					done = false
					break
				}
			}
			if done {
				return
			}
		}
		select {
		case <-ctx.Done():
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
