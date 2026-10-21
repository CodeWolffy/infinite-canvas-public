package platform

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"math/rand/v2"
	"net"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/minio/minio-go/v7"
	"github.com/redis/go-redis/v9"
	"github.com/shopspring/decimal"
)

// 沿用视频接口已有的 2.5 秒轮询节奏；状态与余额始终以 PostgreSQL 为准。
const queuePoll = 2500 * time.Millisecond

// 空队列时的退避上限与恢复扫描周期。
const (
	queuePollMax    = 10 * time.Second
	recoverInterval = 5 * time.Second
)

// cleanupBatch 是一次批量删除对象存储的文件数。
const cleanupBatch = 100

type generationResult struct {
	Data             []byte
	Text, UpstreamID string
	Pending          bool
	PromptTokens     int64
	CachedTokens     int64
	CompletionTokens int64
	DurationSeconds  string
}
type upstreamError struct {
	Category  string
	Status    int
	Retryable bool
	Message   string
}

func (e *upstreamError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return upstreamMessage(e.Category)
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int64:
		return float64(n), true
	case string:
		if f, err := strconv.ParseFloat(n, 64); err == nil {
			return f, true
		}
	case decimal.Decimal:
		f, _ := n.Float64()
		return f, true
	}
	return 0, false
}

// token 费用参考 new-api 的计价公式：(输入 - 缓存命中) × 输入价 + 缓存命中 × 缓存价 + 输出 × 输出价，
// 各项按百万 token 单价向上取整到微元，避免极低价模型累计出小于 1 微元的欠账。
func tokenCost(promptTokens, cachedTokens, completionTokens, inputPrice, cachedPrice, outputPrice int64) (int64, error) {
	if min(promptTokens, cachedTokens, completionTokens, inputPrice, cachedPrice, outputPrice) < 0 {
		return 0, problem(400, "invalid_usage", "用量或单价不能为负数")
	}
	cached := min(cachedTokens, promptTokens)
	billed := decimal.NewFromInt(promptTokens - cached).Mul(decimal.NewFromInt(inputPrice)).Add(decimal.NewFromInt(cached).Mul(decimal.NewFromInt(cachedPrice))).Add(decimal.NewFromInt(completionTokens).Mul(decimal.NewFromInt(outputPrice)))
	return roundedMicros(billed.Div(decimal.NewFromInt(1_000_000)))
}
func upstreamMessage(category string) string {
	switch category {
	case "content_policy":
		return "上游拒绝了此内容，请调整提示词"
	case "rate_limit":
		return "上游请求频率受限"
	case "authentication":
		return "上游渠道鉴权失败"
	case "invalid_request":
		return "上游不支持当前生成参数"
	case "timeout":
		return "生成超时，冻结余额已退回"
	case "storage":
		return "生成结果未能保存，冻结余额已退回"
	case "storage_quota":
		return "当前分组存储已达上限，冻结余额已退回"
	case "canceled":
		return "任务已取消"
	case "account_disabled":
		return "账号已停用"
	case "model_forbidden":
		return "当前分组无权使用此模型，冻结余额已退回"
	case "stream_interrupted":
		return "文本流中断，冻结余额已退回，可手动重试"
	case "duration_unavailable":
		return "音频时长读取失败，冻结余额已退回，请联系管理员检查 ffprobe"
	case "no_channel":
		return "模型暂无可用渠道"
	default:
		return "生成未完成，冻结余额已退回；可查看任务后手动重试"
	}
}
func classify(err error) *upstreamError {
	var upstream *upstreamError
	if errors.As(err, &upstream) {
		return upstream
	}
	var api *apiError
	if errors.As(err, &api) && (api.Code == "storage_quota" || api.Code == "wallet_in_debt") {
		return &upstreamError{Category: api.Code, Message: api.Message}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &upstreamError{Category: "timeout", Retryable: true}
	}
	if errors.Is(err, context.Canceled) {
		return &upstreamError{Category: "canceled"}
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return &upstreamError{Category: "upstream_error", Retryable: true}
	}
	var network net.Error
	if errors.As(err, &network) {
		if network.Timeout() {
			return &upstreamError{Category: "timeout", Retryable: true}
		}
		return &upstreamError{Category: "upstream_error", Retryable: true}
	}
	return &upstreamError{Category: "upstream_error"}
}

type channel struct {
	ID, Name, Protocol, BaseURL, APIKey, UpstreamModel, BindingID string
	KeyID, KeyStrategy, TaskAdapter, EndpointPath               string
	TimeoutMS, MaxConcurrency, CooldownSeconds, Priority, Weight int
	CostConfig                                                   map[string]any
}

func (a *App) channelFromRow(row Row) channel {
	c := channel{ID: str(row["id"]), BindingID: str(row["bindingId"]), Name: str(row["name"]), Protocol: str(row["protocol"]), BaseURL: str(row["baseUrl"]), UpstreamModel: str(row["upstreamModel"]), TimeoutMS: int(integer(row["timeoutMs"])), MaxConcurrency: int(integer(row["maxConcurrency"])), CooldownSeconds: int(integer(row["cooldownSeconds"])), Priority: int(integer(row["priority"])), Weight: int(integer(row["weight"])), EndpointPath: str(row["endpointPath"])}
	c.CostConfig = object(row["costConfig"])
	c.KeyStrategy, c.TaskAdapter = str(row["keyStrategy"]), str(row["taskAdapter"])
	return c
}
func (a *App) candidates(ctx context.Context, modelID string, excludedChannels, excludedKeys []string) ([]channel, error) {
	items, err := rows(ctx, a.DB, `SELECT c.*,v.binding_id,v.upstream_model,v.priority,v.weight,v.cost_config
		FROM available_model_channels v JOIN channels c ON c.id=v.channel_id
		WHERE v.model_id=$1 AND (v.cooldown_until IS NULL OR v.cooldown_until<=now())
		AND NOT(c.id=ANY(coalesce($2::text[]::uuid[],'{}'))) AND EXISTS(SELECT 1 FROM channel_keys k WHERE k.channel_id=c.id AND k.status='active' AND NOT(k.id=ANY(coalesce($3::text[]::uuid[],'{}'))))
		ORDER BY v.priority DESC`, modelID, excludedChannels, excludedKeys)
	if err != nil {
		return nil, err
	}
	type ranked struct {
		candidate channel
		rank      float64
	}
	rankings := []ranked{}
	for _, row := range items {
		c := a.channelFromRow(row)
		rankings = append(rankings, ranked{c, -math.Log(1-rand.Float64()) / float64(c.Weight)})
	}
	sort.Slice(rankings, func(i, j int) bool {
		if rankings[i].candidate.Priority != rankings[j].candidate.Priority {
			return rankings[i].candidate.Priority > rankings[j].candidate.Priority
		}
		return rankings[i].rank < rankings[j].rank
	})
	result := []channel{}
	for _, r := range rankings {
		result = append(result, r.candidate)
	}
	return result, nil
}

var acquireSlot = redis.NewScript(`
local stamp=redis.call('TIME'); local now=stamp[1]*1000+math.floor(stamp[2]/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now)
if redis.call('ZSCORE',KEYS[1],ARGV[1]) then return 1 end
if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[2]) then return 0 end
redis.call('ZADD',KEYS[1],now+tonumber(ARGV[3]),ARGV[1]); redis.call('PEXPIRE',KEYS[1],math.max(redis.call('PTTL',KEYS[1]),tonumber(ARGV[3])))
return 1`)

func slotReference(task Row) string {
	if token := str(task["slotToken"]); token != "" {
		return token
	}
	return taskReference(task)
}
func (a *App) slot(ctx context.Context, c channel, task Row, deadline time.Time) (bool, error) {
	duration := time.Until(deadline).Milliseconds()
	if duration <= 0 {
		return false, context.DeadlineExceeded
	}
	value, err := acquireSlot.Run(ctx, a.Redis, []string{"ic:slots:" + c.ID}, slotReference(task), c.MaxConcurrency, duration).Int()
	return value == 1, err
}
func (a *App) releaseSlot(c channel, task Row) {
	if err := a.Redis.ZRem(context.Background(), "ic:slots:"+c.ID, slotReference(task)).Err(); err != nil {
		slog.Warn("渠道槽位将按原截止时间回收", "channel", c.ID)
	}
}

func (a *App) StartWorkers(ctx context.Context) {
	a.shutdown = ctx.Done()
	a.startTextEvents(ctx)
	a.startTaskEvents(ctx)
	a.startCancelEvents(ctx)
	a.startMail(ctx)
	a.startMonitoring(ctx)
	a.startMetrics(ctx)
	a.startMetricsSampler(ctx)
	a.workersStarted.Store(true)
	a.workers.Add(1)
	go func() {
		defer a.workers.Done()
		<-ctx.Done()
		a.shuttingDown.Store(true)
	}()
	for i := 0; i < a.Config.WorkerConcurrency; i++ {
		a.workers.Add(1)
		go func() {
			defer a.workers.Done()
			// 空队列时按指数退避降低 SKIP LOCKED 空转；领到任务后立刻恢复原节奏。
			poll := queuePoll
			for ctx.Err() == nil {
				task, err := one(ctx, a.DB, "UPDATE generation_tasks SET status='running',worker_token=$1,started_at=coalesce(started_at,now()),deadline=coalesce(deadline,now()+interval '480 seconds') WHERE id=(SELECT id FROM generation_tasks WHERE status='queued' AND available_at<=now() ORDER BY available_at,queued_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *", uuid.NewString())
				if err == nil {
					poll = queuePoll
					// 状态已落库：批次 SSE 订阅者收到「running」后再开始上游调用。
					a.publishTaskChange(ctx, task)
					a.executeGuarded(ctx, task)
					continue
				}
				if !errors.Is(err, notFound) && ctx.Err() == nil {
					slog.Warn("暂时无法领取任务", "error", err)
				}
				timer := time.NewTimer(poll)
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
				if errors.Is(err, notFound) {
					poll = min(poll*2, queuePollMax)
				}
			}
		}()
	}
	a.workers.Add(1)
	go func() {
		defer a.workers.Done()
		ticker := time.NewTicker(recoverInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				a.recoverTasks(ctx)
			}
		}
	}()
	a.workers.Add(1)
	go func() {
		defer a.workers.Done()
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				a.reconcileExpiredOrders(ctx)
			}
		}
	}()
	a.workers.Add(1)
	go func() {
		defer a.workers.Done()
		// 启动后先跑一次，避免频繁重启的容器永远等不到第一次清理。
		first := time.NewTimer(time.Minute)
		defer first.Stop()
		select {
		case <-ctx.Done():
			return
		case <-first.C:
			a.runCleanup(ctx)
		}
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				a.runCleanup(ctx)
			}
		}
	}()
}

// 任务执行 panic 不打崩进程：提前到期租约，交由既有恢复循环接管重试或退款。
func (a *App) executeGuarded(ctx context.Context, task Row) {
	a.guardExecution(ctx, task, func() { a.executeTask(ctx, task) })
}

// 结算失败只记日志：租约到期后恢复循环会重新接管，worker 不应因此退出。
func (a *App) settle(ctx context.Context, task, media Row, result *generationResult, failure *upstreamError) {
	if err := a.finishTask(ctx, task, media, result, failure); err != nil {
		slog.Warn("任务结算失败", "task", str(task["id"]), "error", err)
	}
}

func (a *App) guardExecution(ctx context.Context, task Row, run func()) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("任务执行异常，等待恢复循环接管", "task", str(task["id"]), "panic", fmt.Sprint(r), "stack", string(debug.Stack()))
			_, _ = a.DB.Exec(context.WithoutCancel(ctx), "UPDATE generation_tasks SET deadline=now() WHERE id=$1 AND worker_token=$2 AND status='running'", task["id"], task["workerToken"])
		}
	}()
	run()
}

func (a *App) executeTask(root context.Context, task Row) {
	ctx := root
	var active bool
	if err := a.DB.QueryRow(ctx, "SELECT status='active' FROM users WHERE id=$1", task["userId"]).Scan(&active); err != nil {
		return
	}
	if !active {
		a.settle(ctx, task, nil, nil, &upstreamError{Category: "account_disabled"})
		return
	}
	if err := a.modelAccess(ctx, a.DB, str(task["userId"]), str(task["modelId"])); err != nil {
		a.settle(ctx, task, nil, nil, &upstreamError{Category: "model_forbidden"})
		return
	}
	var candidates []channel
	var err error
	resuming := str(task["upstreamTaskId"]) != ""
	var attemptedKeys, failedChannels []string
	if !resuming {
		task["slotToken"] = task["workerToken"]
		if err = a.DB.QueryRow(ctx, "SELECT attempted_key_ids::text[],failed_channel_ids::text[] FROM generation_tasks WHERE id=$1", task["id"]).Scan(&attemptedKeys, &failedChannels); err != nil {
			return
		}
		if integer(task["attemptCount"]) >= integer(task["maxAttempts"]) {
			a.settle(ctx, task, nil, nil, &upstreamError{Category: str(task["errorCode"]), Message: str(task["errorMessage"])})
			return
		}
	}
	if resuming {
		raw, err := a.unseal(str(task["channelSnapshot"]))
		if err != nil {
			a.settle(ctx, task, nil, nil, classify(err))
			return
		}
		var saved channel
		if err = json.Unmarshal([]byte(raw), &saved); err != nil {
			a.settle(ctx, task, nil, nil, classify(err))
			return
		}
		candidates = []channel{saved}
	} else {
		candidates, err = a.candidates(ctx, str(task["modelId"]), failedChannels, attemptedKeys)
		if err != nil {
			return
		}
	}
	if len(candidates) == 0 {
		if integer(task["attemptCount"]) > 0 {
			a.settle(ctx, task, nil, nil, &upstreamError{Category: str(task["errorCode"]), Message: str(task["errorMessage"])})
			return
		}
		var configured bool
		err = a.DB.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM available_model_channels v WHERE v.model_id=$1)", task["modelId"]).Scan(&configured)
		if err != nil {
			return
		}
		if configured {
			a.requeue(ctx, task, false)
			return
		}
		a.notifyNoChannel(ctx, str(task["modelId"]))
		a.settle(ctx, task, nil, nil, &upstreamError{Category: "no_channel"})
		return
	}
	var last *upstreamError
	var attemptChannel channel
	var logID string
	upstreamFailed := false
	canceled := false
	for _, candidate := range candidates {
		deadline := task["deadline"].(time.Time)
		if !resuming {
			deadline = time.Now().Add(time.Duration(candidate.TimeoutMS) * time.Millisecond)
		}
		acquired, err := a.slot(ctx, candidate, task, deadline)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				a.settle(ctx, task, nil, nil, classify(err))
			} else {
				a.requeue(ctx, task, resuming)
			}
			return
		}
		if !acquired {
			continue
		}
		keepSlot := false
		func() {
			defer func() {
				if last != nil && upstreamFailed && logID != "" {
					last.Message = (&upstreamTrace{secret: candidate.APIKey}).redact(last.Message)
					if err := a.recordAttemptFailure(context.WithoutCancel(ctx), candidate, logID, last); err != nil {
						last = &upstreamError{Category: "storage"}
					}
				}
				if !keepSlot {
					a.releaseSlot(candidate, task)
				}
			}()
			if !resuming {
				var eligible bool
				if candidate.BindingID != "" {
					err = a.DB.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM available_model_channels v WHERE v.binding_id=$1 AND (v.cooldown_until IS NULL OR v.cooldown_until<=now()))", candidate.BindingID).Scan(&eligible)
				} else {
					err = a.DB.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM available_model_channels v WHERE v.model_id=$1 AND v.channel_id=$2 AND (v.cooldown_until IS NULL OR v.cooldown_until<=now()))", task["modelId"], candidate.ID).Scan(&eligible)
				}
				if err != nil || !eligible {
					return
				}
				if err = a.selectChannelKey(ctx, &candidate, attemptedKeys, false); err != nil {
					return
				}
			}
			attemptChannel = candidate
			jobCtx, cancel := context.WithDeadline(ctx, deadline)
			defer cancel()
			snapshot, err := a.seal(string(jsonBytes(candidate)))
			if err != nil {
				last = classify(err)
				return
			}
			updated, err := a.DB.Exec(jobCtx, `UPDATE generation_tasks SET deadline=$3,channel_id=$4,channel_snapshot=$5,upstream_model=$6,slot_token=$8,
				attempt_count=attempt_count+CASE WHEN $7 THEN 0 ELSE 1 END,
				attempted_key_ids=CASE WHEN $7 THEN attempted_key_ids ELSE array_append(attempted_key_ids,$9::uuid) END
				WHERE id=$1 AND worker_token=$2 AND status='running' AND ($7 OR attempt_count<max_attempts)`, task["id"], task["workerToken"], deadline, candidate.ID, snapshot, candidate.UpstreamModel, resuming, task["slotToken"], nullable(candidate.KeyID))
			if err != nil || updated.RowsAffected() != 1 {
				return
			}
			task["deadline"] = deadline
			// 与取消共用任务行锁；只有取得提交权后才创建调用记录并访问上游。
			submitted, err := a.submitTask(jobCtx, task)
			if err != nil {
				last = classify(err)
				return
			}
			if !submitted {
				canceled = true
				return
			}
			a.publishTaskChange(jobCtx, task)
			log, err := one(jobCtx, a.DB, "SELECT id FROM request_logs WHERE task_id=$1 AND status='running' ORDER BY started_at DESC LIMIT 1", task["id"])
			if errors.Is(err, notFound) {
				log, err = one(jobCtx, a.DB, "INSERT INTO request_logs(user_id,type,task_id,model_id,model_name_snapshot,model_display_name_snapshot,channel_id,channel_name_snapshot,upstream_model,status,key_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'running',$10) RETURNING id", task["userId"], task["capability"], task["id"], task["modelId"], task["modelName"], task["modelDisplayName"], candidate.ID, candidate.Name, candidate.UpstreamModel, nullable(candidate.KeyID))
			}
			if err != nil {
				last = &upstreamError{Category: "storage"}
				return
			}
			logID = str(log["id"])
			if _, err = a.DB.Exec(jobCtx, "INSERT INTO upstream_cost_entries(id,task_id,user_id,model_id,channel_id,capability,cost_config,key_id,binding_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING", log["id"], task["id"], task["userId"], task["modelId"], candidate.ID, task["capability"], jsonBytes(candidate.CostConfig), nullable(candidate.KeyID), nullable(candidate.BindingID)); err != nil {
				last = &upstreamError{Category: "storage"}
				return
			}
			// 进程退出仍可中断执行；用户在提交标记落库后不能取消。
			runCtx, stopRun := context.WithCancel(jobCtx)
			defer stopRun()
			taskID := str(task["id"])
			a.running.Store(taskID, context.CancelFunc(stopRun))
			defer a.running.Delete(taskID)
			result, err := a.generate(runCtx, candidate, task)
			_, _ = a.DB.Exec(context.WithoutCancel(ctx), "UPDATE upstream_cost_entries SET duration_ms=(extract(epoch FROM(now()-created_at))*1000)::bigint WHERE id=$1", logID)
			if err != nil {
				if resuming && root.Err() != nil {
					a.requeue(context.Background(), task, true)
					keepSlot = true
					task["status"] = "queued"
					return
				}
				last = classify(err)
				// 进程退出：在途任务重排回队列，不计失败也不退款，重启后继续执行。
				if root.Err() != nil && last.Category == "canceled" {
					a.requeueInterrupted(context.Background(), task, candidate)
					task["status"] = "queued"
					return
				}
				// 用户取消：任务行已由 cancelTask 改为 canceled，这里不重试也不结算。
				if last.Category == "canceled" && root.Err() == nil {
					canceled = true
					return
				}
				upstreamFailed = true
				return
			}
			if result.Pending {
				if result.UpstreamID == "" {
					last = &upstreamError{Category: "upstream_error"}
					upstreamFailed = true
					return
				}
				persistCtx := ctx
				if ctx.Err() != nil {
					persistCtx = context.Background()
				}
				resultTag, err := a.DB.Exec(persistCtx, "UPDATE generation_tasks SET upstream_task_id=$3,status='queued',available_at=now()+interval '2.5 seconds',worker_token=NULL WHERE id=$1 AND worker_token=$2 AND status='running'", task["id"], task["workerToken"], result.UpstreamID)
				if err == nil && resultTag.RowsAffected() == 1 {
					keepSlot = true
					task["status"] = "queued"
				} else {
					last = &upstreamError{Category: "storage"}
				}
				return
			}
			// 非文本任务必须拿到并持久化媒体结果才能成功结算，空结果按上游失败处理。
			if task["capability"] != "text" && len(result.Data) == 0 {
				last = &upstreamError{Category: "upstream_error", Retryable: true}
				upstreamFailed = true
				return
			}
			if updated, err := a.DB.Exec(context.WithoutCancel(ctx), "UPDATE generation_tasks SET upstream_completed=true WHERE id=$1 AND worker_token=$2 AND status='running'", task["id"], task["workerToken"]); err != nil || updated.RowsAffected() != 1 {
				last = &upstreamError{Category: "storage"}
				return
			}
			if task["capability"] == "audio" && len(result.Data) > 0 && (task["pricePerSecond"] != nil || candidate.CostConfig["second"] != nil) {
				result.DurationSeconds, err = audioDuration(jobCtx, result.Data)
				if err != nil && task["pricePerSecond"] != nil {
					last = &upstreamError{Category: "duration_unavailable"}
					return
				}
			}
			seconds := task["seconds"]
			if seconds == nil {
				seconds = object(task["parameters"])["seconds"]
			}
			if err = a.recordCost(jobCtx, str(log["id"]), result, seconds, candidate.CostConfig); err != nil {
				last = &upstreamError{Category: "storage"}
				return
			}
			var media Row
			if len(result.Data) > 0 {
				media, err = a.storeMedia(jobCtx, str(task["userId"]), result.Data, "")
				if err != nil {
					// 保留已识别的配额/超时分类，其余保存故障统一归为存储失败。
					last = &upstreamError{Category: "storage"}
					if failure := classify(err); failure.Category == "storage_quota" || failure.Category == "timeout" {
						last = failure
					}
					return
				}
				kind := str(task["capability"])
				if !strings.HasPrefix(str(media["mimeType"]), kind+"/") && !(kind == "audio" && str(media["mimeType"]) == "application/ogg") {
					last = &upstreamError{Category: "invalid_result"}
					return
				}
			}
			if err = a.finishTask(ctx, task, media, &result, nil); err != nil {
				last = &upstreamError{Category: "storage"}
				return
			}
			task["status"] = "succeeded"
			_ = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
				if err := recordKeySuccess(ctx, tx, candidate, task["startedAt"].(time.Time)); err != nil {
					return err
				}
				result, err := tx.Exec(ctx, "UPDATE channels SET last_success_at=now(),last_error_code=NULL,cooldown_until=NULL WHERE id=$1 AND (last_failure_at IS NULL OR last_failure_at<$2) AND (last_error_code IS NOT NULL OR cooldown_until IS NOT NULL)", candidate.ID, task["startedAt"])
				if err != nil {
					return err
				}
				recovered := result.RowsAffected() > 0
				// 每次成功都让连续失败计数回落一档，间歇性故障不会积累到熔断阈值。
				if _, err = tx.Exec(ctx, "UPDATE channels SET consecutive_request_failures=GREATEST(consecutive_request_failures-1,0) WHERE id=$1 AND consecutive_request_failures>0 AND (last_failure_at IS NULL OR last_failure_at<$2)", candidate.ID, task["startedAt"]); err != nil {
					return err
				}
				if !recovered {
					return nil
				}
				return a.notification(ctx, tx, "", "recovered:"+taskReference(task), "channel.recovered", "渠道已恢复", candidate.Name+" 已恢复正常生成。")
			})
		}()
		if canceled {
			return
		}
		if task["status"] == "succeeded" || task["status"] == "queued" {
			return
		}
		if last != nil {
			break
		}
	}
	if last == nil {
		a.requeue(ctx, task, resuming)
		return
	}
	finishCtx := ctx
	if ctx.Err() != nil {
		finishCtx = context.Background()
	}
	if attemptChannel.APIKey != "" {
		last.Message = (&upstreamTrace{secret: attemptChannel.APIKey}).redact(last.Message)
	}
	if !upstreamFailed {
		last.Retryable = false
	}
	if retried, err := a.retryTask(finishCtx, task, attemptChannel, last); err != nil || retried {
		return
	}
	if err := a.finishTask(finishCtx, task, nil, nil, last); err != nil {
		slog.Warn("任务结算等待恢复", "task", task["id"])
	}
}

// 退出中断不是渠道失败：退回本次尝试及其 Key 排除记录，已输出文本或已完成上游的任务禁止重放。
func (a *App) requeueInterrupted(ctx context.Context, task Row, ch channel) {
	var queued bool
	err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		result, err := tx.Exec(ctx, `UPDATE generation_tasks SET status='queued',worker_token=NULL,deadline=NULL,channel_id=NULL,channel_snapshot=NULL,upstream_model=NULL,slot_token=NULL,
			attempt_count=GREATEST(attempt_count-1,0),attempted_key_ids=array_remove(attempted_key_ids,$3::uuid),available_at=now()
			WHERE id=$1 AND worker_token=$2 AND status='running' AND upstream_task_id IS NULL AND partial_text='' AND NOT upstream_completed`, task["id"], task["workerToken"], nullable(ch.KeyID))
		if err != nil || result.RowsAffected() == 0 {
			return err
		}
		queued = true
		if _, err = tx.Exec(ctx, "UPDATE request_logs SET status='failed',error_category='shutdown',error_message='服务重启中断，任务已重新排队',finished_at=now(),duration_ms=(extract(epoch FROM(now()-started_at))*1000)::integer WHERE task_id=$1 AND status='running'", task["id"]); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, "UPDATE upstream_cost_entries SET status='canceled',updated_at=now() WHERE task_id=$1 AND status='running'", task["id"])
		return err
	})
	if err != nil {
		slog.Warn("退出重排失败，等待租约恢复", "task", task["id"], "error", err)
	} else if queued {
		a.publishTaskChange(ctx, task)
	} else {
		a.settle(ctx, task, nil, nil, &upstreamError{Category: "stream_interrupted"})
	}
}

func (a *App) requeue(ctx context.Context, task Row, resuming bool) {
	query := "UPDATE generation_tasks SET status='queued',worker_token=NULL,deadline=NULL,available_at=now()+interval '2.5 seconds' WHERE id=$1 AND worker_token=$2 AND status='running'"
	if resuming {
		query = "UPDATE generation_tasks SET status='queued',worker_token=NULL,available_at=now()+interval '2.5 seconds' WHERE id=$1 AND worker_token=$2 AND status='running'"
	}
	result, err := a.DB.Exec(ctx, query, task["id"], task["workerToken"])
	if err != nil {
		slog.Warn("任务重排失败", "task", str(task["id"]), "resuming", resuming, "error", err)
		return
	}
	if result.RowsAffected() == 1 {
		a.publishTaskChange(ctx, task)
	}
}

// 一次换渠道沿用原冻结额，持久化次数和排除列表；已输出文本/已受理异步任务不重放。
func (a *App) retryTask(ctx context.Context, task Row, ch channel, failure *upstreamError) (bool, error) {
	if !failure.Retryable {
		return false, nil
	}
	result, err := a.DB.Exec(ctx, `UPDATE generation_tasks SET status='queued',worker_token=NULL,deadline=NULL,channel_id=NULL,channel_snapshot=NULL,slot_token=NULL,
		failed_channel_ids=CASE WHEN $5='authentication' THEN failed_channel_ids ELSE array_append(failed_channel_ids,$3::uuid) END,
		error_code=$5,error_message=$4,available_at=now()
		WHERE id=$1 AND worker_token=$2 AND status='running' AND attempt_count<max_attempts AND upstream_task_id IS NULL AND partial_text='' AND NOT upstream_completed
		AND EXISTS(SELECT 1 FROM available_model_channels v
			WHERE v.model_id=generation_tasks.model_id
			AND v.capability=generation_tasks.capability AND (v.cooldown_until IS NULL OR v.cooldown_until<=now())
			AND NOT(v.channel_id=ANY(generation_tasks.failed_channel_ids)) AND ($5='authentication' OR v.channel_id<>$3::uuid)
			AND EXISTS(SELECT 1 FROM channel_keys k WHERE k.channel_id=v.channel_id AND k.status='active' AND NOT(k.id=ANY(generation_tasks.attempted_key_ids))))`,
		task["id"], task["workerToken"], nullable(ch.ID), failure.Error(), failure.Category)
	if err != nil {
		return false, err
	}
	retried := result.RowsAffected() == 1
	if retried {
		a.publishTaskChange(ctx, task)
	}
	return retried, nil
}
func (a *App) recordAttemptFailure(ctx context.Context, c channel, logID string, failure *upstreamError) error {
	upstreamAttemptsTotal.WithLabelValues(c.ID, failure.Category).Inc()
	return pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "UPDATE upstream_cost_entries SET status='failed',duration_ms=coalesce(duration_ms,(extract(epoch FROM(now()-created_at))*1000)::bigint),updated_at=now() WHERE id=$1", logID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "UPDATE request_logs SET status='failed',http_status=$2,error_category=$3,error_message=$4,finished_at=now(),duration_ms=(extract(epoch FROM(now()-started_at))*1000)::integer WHERE id=$1", logID, nullableStatus(failure.Status), failure.Category, failure.Error()); err != nil {
			return err
		}
		if failure.Category == "authentication" {
			return recordKeyFailure(ctx, tx, c, failure)
		}
		if !channelFailure(failure) {
			return nil
		}
		old, err := one(ctx, tx, "SELECT last_error_code,consecutive_request_failures,auto_disabled_at FROM channels WHERE id=$1 FOR UPDATE", c.ID)
		if err != nil {
			return err
		}
		count := integer(old["consecutiveRequestFailures"])
		cooldown := int64(c.CooldownSeconds)
		disable := false
		if channelRequestFailure(failure.Category) {
			count++
			cooldown *= cooldownBackoff(count)
			settings, err := a.settings(ctx, tx)
			if err != nil {
				return err
			}
			disable = settings.RequestAutoDisableAfter > 0 && count >= int64(settings.RequestAutoDisableAfter) && old["autoDisabledAt"] == nil
		}
		if _, err = tx.Exec(ctx, `UPDATE channels SET last_failure_at=now(),last_error_code=$2,cooldown_until=now()+($3*interval '1 second'),
			consecutive_request_failures=$4,auto_disabled_at=CASE WHEN $5 THEN coalesce(auto_disabled_at,now()) ELSE auto_disabled_at END
			WHERE id=$1`, c.ID, failure.Category, cooldown, count, disable); err != nil {
			return err
		}
		if disable {
			return a.notification(ctx, tx, "", "request-disabled:"+logID, "channel.disabled", "渠道已自动停用", c.Name+" 连续多次调用失败，已停止接单；请在渠道编辑中保存为「启用」恢复。")
		}
		if str(old["lastErrorCode"]) != failure.Category {
			return a.notification(ctx, tx, "", "failure:"+logID, "channel.failure", "渠道调用异常", c.Name+"："+failure.Error())
		}
		return nil
	})
}
func nullableStatus(status int) any {
	if status == 0 {
		return nil
	}
	return status
}

func (a *App) finishTask(ctx context.Context, original, media Row, result *generationResult, failure *upstreamError) error {
	err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		if err := lockWallet(ctx, tx, str(original["userId"])); err != nil {
			return err
		}
		task, err := loadSettlementTask(ctx, tx, str(original["id"]))
		if err != nil {
			return err
		}
		if task.Status != "running" || task.WorkerToken == nil || *task.WorkerToken != str(original["workerToken"]) || task.Run != integer(original["run"]) {
			return nil
		}
		// 结算前的最终防护：非文本任务没有媒体结果不允许按成功扣费。
		if failure == nil && task.Capability != "text" && media == nil {
			failure = &upstreamError{Category: "upstream_error"}
		}
		price := task.PriceMicros
		status := "succeeded"
		var errorCode, errorMessage, mediaID, messageID any
		var billedMicros, calculatedMicros int64
		var actualSeconds any
		var promptTokens, cachedTokens, completionTokens any
		if failure != nil {
			status = "failed"
			errorCode = failure.Category
			errorMessage = failure.Error()
			if _, err = changeWallet(ctx, tx, task.UserID, "release", task.reference(), price, -price, "生成失败退回冻结余额"); err != nil {
				return err
			}
		} else {
			if media != nil {
				mediaID = media["id"]
				if err = syncMediaRefs(ctx, tx, "task", task.ID, task.UserID, []string{str(mediaID)}); err != nil {
					return err
				}
			}
			if task.Capability == "text" {
				if strings.TrimSpace(result.Text) == "" {
					return errors.New("文本结果为空")
				}
				messageID = uuid.NewString()
				if _, err = tx.Exec(ctx, "INSERT INTO messages(id,conversation_id,role,content) VALUES($1,$2,'assistant',$3)", messageID, task.ConversationID, result.Text); err != nil {
					return err
				}
				if _, err = tx.Exec(ctx, "UPDATE conversations SET updated_at=now() WHERE id=$1", task.ConversationID); err != nil {
					return err
				}
			}
			billedMicros = price
			usageBased := false
			if task.Capability == "text" {
				promptTokens, cachedTokens, completionTokens = result.PromptTokens, result.CachedTokens, result.CompletionTokens
			}
			if task.PricingKind == "token" && task.Capability == "text" {
				usageBased = true
				promptTokens, cachedTokens, completionTokens = result.PromptTokens, result.CachedTokens, result.CompletionTokens
				cachedPrice := task.InputPrice
				if task.CachedPrice != nil {
					cachedPrice = *task.CachedPrice
				}
				// 上游未返回 usage 时回退按冻结额结算，避免按 0 计费。
				if result.PromptTokens > 0 || result.CompletionTokens > 0 {
					billedMicros, err = tokenCost(result.PromptTokens, result.CachedTokens, result.CompletionTokens, task.InputPrice, cachedPrice, task.OutputPrice)
					if err != nil {
						return err
					}
				} else {
					usageBased = false
				}
			} else if task.PricePerSecond != nil && (task.Capability == "video" || task.Capability == "audio") {
				duration := task.Seconds
				if task.Capability == "audio" && result.DurationSeconds != "" {
					duration = result.DurationSeconds
					actualSeconds = duration
				}
				if seconds, e := boundedDecimal(duration, 131072, 16383); e == nil && seconds.IsPositive() {
					billedMicros, err = roundedMicros(seconds.Mul(decimal.NewFromInt(*task.PricePerSecond)))
					if err != nil {
						return err
					}
					usageBased = true
				}
			}
			calculatedMicros = billedMicros
			if usageBased {
				// 冻结额只是预算，实际费用完整入账；不足部分记为欠费，后续到账先抵扣。
				if _, err = changeWallet(ctx, tx, task.UserID, "charge", task.reference(), price-billedMicros, -price, "生成成功按实际费用结算"); err != nil {
					return err
				}
			} else if _, err = changeWallet(ctx, tx, task.UserID, "charge", task.reference(), 0, -price, "生成成功结算"); err != nil {
				return err
			}
		}
		if _, err = tx.Exec(ctx, "UPDATE generation_tasks SET status=$2,output_media_id=$3,response_message_id=$4,error_code=$5,error_message=$6,finished_at=now(),worker_token=NULL,prompt_tokens=$7,cached_tokens=$8,completion_tokens=$9,billed_micros=$10,calculated_micros=$11,seconds=coalesce($12,seconds),partial_text=CASE WHEN $2='succeeded' THEN '' ELSE partial_text END WHERE id=$1", task.ID, status, mediaID, messageID, errorCode, errorMessage, promptTokens, cachedTokens, completionTokens, billedMicros, calculatedMicros, actualSeconds); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "UPDATE upstream_cost_entries SET status=$2,updated_at=now() WHERE task_id=$1 AND status='running'", task.ID, status); err != nil {
			return err
		}
		billed := "0"
		if failure == nil {
			billed = money(billedMicros)
		}
		_, err = tx.Exec(ctx, "UPDATE request_logs SET status=$2,error_category=$3,error_message=$4,billed_amount=$5,finished_at=now(),duration_ms=(extract(epoch FROM(now()-started_at))*1000)::integer,first_token_ms=(SELECT (extract(epoch FROM(first_token_at-request_logs.started_at))*1000)::integer FROM generation_tasks WHERE id=$1),output_tokens=$6 WHERE task_id=$1 AND status='running'", task.ID, status, errorCode, errorMessage, billed, integer(completionTokens))
		return err
	})
	if err == nil {
		a.publishTaskChange(ctx, original)
	}
	if err == nil && failure == nil {
		upstreamAttemptsTotal.WithLabelValues(str(original["channelId"]), "success").Inc()
		_ = a.notifyLowBalance(ctx, a.DB, str(original["userId"]))
	}
	return err
}
func (a *App) recoverTasks(ctx context.Context) {
	a.logExec(ctx, "回收超时上游成本记录", "UPDATE upstream_cost_entries SET status='failed',updated_at=now() WHERE task_id IS NULL AND status='running' AND deadline<now()")
	tasks, err := rows(ctx, a.DB, "SELECT * FROM generation_tasks WHERE status='running' AND deadline<now() ORDER BY deadline LIMIT 100")
	if err != nil {
		slog.Warn("读取超时任务失败", "error", err)
		return
	}
	for _, pending := range tasks {
		// 先接管过期租约，旧 worker 的迟到结果无法结算或覆盖下一次尝试。
		task, err := one(ctx, a.DB, "UPDATE generation_tasks SET worker_token=$3 WHERE id=$1 AND worker_token=$2 AND status='running' AND deadline<now() RETURNING *", pending["id"], pending["workerToken"], uuid.NewString())
		if err != nil {
			slog.Warn("恢复任务失败", "task", str(pending["id"]), "error", err)
			continue
		}
		failure := &upstreamError{Category: "timeout", Retryable: true}
		var ch channel
		if raw, err := a.unseal(str(task["channelSnapshot"])); err == nil {
			_ = json.Unmarshal([]byte(raw), &ch)
		}
		if ch.ID != "" {
			a.releaseSlot(ch, task)
			if log, err := one(ctx, a.DB, "SELECT id,status,error_category,error_message,http_status FROM request_logs WHERE task_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1", task["id"]); err == nil && task["upstreamCompleted"] != true {
				if log["status"] == "failed" {
					failure = &upstreamError{Category: str(log["errorCategory"]), Message: str(log["errorMessage"]), Status: int(integer(log["httpStatus"]))}
					failure.Retryable = channelFailure(failure)
				} else if err = a.recordAttemptFailure(ctx, ch, str(log["id"]), failure); err != nil {
					slog.Warn("恢复任务记录失败尝试失败", "task", str(task["id"]), "error", err)
					continue
				}
			}
			if retry, err := a.retryTask(ctx, task, ch, failure); err != nil || retry {
				if err != nil {
					slog.Warn("恢复任务重排失败", "task", str(task["id"]), "error", err)
				}
				continue
			}
		}
		a.settle(ctx, task, nil, nil, failure)
	}
}
func (a *App) reconcileExpiredOrders(ctx context.Context) {
	// 每轮随机排序：最早一批订单若持续无法确认，不会一直挡住后面的订单。
	items, err := rows(ctx, a.DB, "SELECT * FROM payment_orders WHERE status='pending' AND expires_at<=now() ORDER BY md5(id::text||$1) LIMIT 100", uuid.NewString())
	if err != nil {
		return
	}
	for _, order := range items {
		if ctx.Err() != nil {
			return
		}
		deadlineCtx, cancel := context.WithTimeout(ctx, 480*time.Second)
		_ = a.reconcilePayment(deadlineCtx, order)
		cancel()
	}
}

// runCleanup 由启动后与每日定时触发；多实例部署靠 Redis 锁保证只跑一份。
func (a *App) runCleanup(ctx context.Context) {
	if !a.cleanupLock(ctx) {
		return
	}
	a.cleanup(ctx)
}

func (a *App) cleanupLock(ctx context.Context) bool {
	if a.Redis == nil {
		return true
	}
	acquired, err := a.Redis.SetNX(ctx, "ic:cleanup:lock", uuid.NewString(), time.Hour).Result()
	if err != nil {
		slog.Warn("清理锁获取失败", "error", err)
		return false
	}
	return acquired
}

func (a *App) cleanup(ctx context.Context) {
	a.logExec(ctx, "清理过期登录令牌", "DELETE FROM auth_tokens WHERE expires_at<now()")
	a.logExec(ctx, "清理过期邮件", "DELETE FROM mail_outbox WHERE created_at<now()-($1*interval '1 day') AND status IN('sent','failed')", a.Config.LogDays)
	a.logExec(ctx, "清理过期会话", "DELETE FROM sessions WHERE expires_at<now()")
	a.logExec(ctx, "清理过期请求日志", "DELETE FROM request_logs WHERE started_at<now()-($1*interval '1 day') AND status<>'running'", a.Config.LogDays)
	a.logExec(ctx, "清理过期渠道检测记录", "DELETE FROM channel_checks WHERE created_at<now()-($1*interval '1 day')", checkRetentionDays)
	a.logExec(ctx, "清理过期通知", "DELETE FROM notifications WHERE created_at<now()-($1*interval '1 day')", notificationRetentionDays)
	a.logExec(ctx, "清理过期审计日志", "DELETE FROM audit_logs WHERE created_at<now()-($1*interval '1 day') AND action<>'cost.reconciled'", auditRetentionDays)
	items, err := rows(ctx, a.DB, "SELECT id FROM media_objects WHERE (status='deleting' OR created_at<now()-($1*interval '1 day')) AND NOT EXISTS(SELECT 1 FROM media_references WHERE media_id=media_objects.id) AND NOT EXISTS(SELECT 1 FROM generation_tasks WHERE output_media_id=media_objects.id) AND NOT EXISTS(SELECT 1 FROM assets WHERE media_id=media_objects.id)", a.Config.OrphanDays)
	if err != nil {
		slog.Warn("读取待清理媒体失败", "error", err)
		return
	}
	for start := 0; start < len(items); start += cleanupBatch {
		end := min(start+cleanupBatch, len(items))
		pending := []pendingMedia{}
		for _, item := range items[start:end] {
			if key, err := a.markMediaDeleting(ctx, str(item["id"])); err == nil {
				pending = append(pending, pendingMedia{id: str(item["id"]), key: key})
			}
		}
		if len(pending) == 0 {
			continue
		}
		objects := make(chan minio.ObjectInfo, len(pending))
		for _, item := range pending {
			objects <- minio.ObjectInfo{Key: item.key}
		}
		close(objects)
		failed := make(map[string]bool)
		batchFailed := false
		for failure := range a.S3.RemoveObjects(ctx, a.Config.Bucket, objects, minio.RemoveObjectsOptions{}) {
			slog.Warn("删除媒体对象失败", "key", failure.ObjectName, "error", failure.Err)
			if failure.ObjectName == "" {
				batchFailed = true
			} else {
				failed[failure.ObjectName] = true
			}
		}
		if batchFailed {
			continue
		}
		for _, item := range pending {
			if !failed[item.key] {
				a.logExec(ctx, "清理媒体记录", "DELETE FROM media_objects WHERE id=$1 AND status='deleting'", item.id)
			}
		}
	}
}

type pendingMedia struct{ id, key string }

// markMediaDeleting 在事务内二次确认没有引用，再把记录标记为 deleting 并返回对象键。
func (a *App) markMediaDeleting(ctx context.Context, id string) (string, error) {
	var key string
	err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		row, err := one(ctx, tx, "SELECT * FROM media_objects WHERE id=$1 FOR UPDATE", id)
		if err != nil {
			return err
		}
		var referenced bool
		if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM media_references WHERE media_id=$1) OR EXISTS(SELECT 1 FROM generation_tasks WHERE output_media_id=$1) OR EXISTS(SELECT 1 FROM assets WHERE media_id=$1)", id).Scan(&referenced); err != nil {
			return err
		}
		if referenced {
			return notFound
		}
		key = str(row["objectKey"])
		_, err = tx.Exec(ctx, "UPDATE media_objects SET status='deleting' WHERE id=$1", id)
		return err
	})
	return key, err
}
