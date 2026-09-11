package platform

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"math/rand/v2"
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
}

func (e *upstreamError) Error() string { return upstreamMessage(e.Category) }

func nullableInt(n int64) any {
	if n == 0 {
		return nil
	}
	return n
}

// toFloat 兼容 pgx 回传的 numeric/float64/int 形式的数值。
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
	if errors.As(err, &api) && api.Code == "storage_quota" {
		return &upstreamError{Category: "storage_quota"}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &upstreamError{Category: "timeout"}
	}
	return &upstreamError{Category: "upstream_error"}
}

type channel struct {
	ID, Name, Protocol, BaseURL, APIKey, UpstreamModel, BindingID string
	TimeoutMS, MaxConcurrency, CooldownSeconds, Priority, Weight int
	CostConfig                                                   map[string]any
}

func (a *App) channelFromRow(row Row) (channel, error) {
	c := channel{ID: str(row["id"]), BindingID: str(row["bindingId"]), Name: str(row["name"]), Protocol: str(row["protocol"]), BaseURL: str(row["baseUrl"]), UpstreamModel: str(row["upstreamModel"]), TimeoutMS: int(integer(row["timeoutMs"])), MaxConcurrency: int(integer(row["maxConcurrency"])), CooldownSeconds: int(integer(row["cooldownSeconds"])), Priority: int(integer(row["priority"])), Weight: int(integer(row["weight"]))}
	c.CostConfig = object(row["costConfig"])
	var err error
	if str(row["encryptedApiKey"]) != "" {
		c.APIKey, err = a.unseal(str(row["encryptedApiKey"]))
	}
	return c, err
}
func (a *App) candidates(ctx context.Context, modelID string) ([]channel, error) {
	items, err := rows(ctx, a.DB, "SELECT c.*,b.id AS binding_id,b.upstream_model,b.priority,b.weight,b.cost_config FROM model_channels b JOIN channels c ON c.id=b.channel_id JOIN models m ON m.id=b.model_id WHERE b.model_id=$1 AND b.enabled AND c.status='active' AND m.status='published' AND m.deleted_at IS NULL AND (c.cooldown_until IS NULL OR c.cooldown_until<=now()) ORDER BY b.priority DESC", modelID)
	if err != nil {
		return nil, err
	}
	type ranked struct {
		candidate channel
		rank      float64
	}
	rankings := []ranked{}
	for _, row := range items {
		c, err := a.channelFromRow(row)
		if err != nil {
			return nil, err
		}
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

func (a *App) slot(ctx context.Context, c channel, task Row, deadline time.Time) (bool, error) {
	duration := time.Until(deadline).Milliseconds()
	if duration <= 0 {
		return false, context.DeadlineExceeded
	}
	value, err := acquireSlot.Run(ctx, a.Redis, []string{"ic:slots:" + c.ID}, taskReference(task), c.MaxConcurrency, duration).Int()
	return value == 1, err
}
func (a *App) releaseSlot(c channel, task Row) {
	if err := a.Redis.ZRem(context.Background(), "ic:slots:"+c.ID, taskReference(task)).Err(); err != nil {
		slog.Warn("渠道槽位将按原截止时间回收", "channel", c.ID)
	}
}

func (a *App) StartWorkers(ctx context.Context) {
	a.shutdown = ctx.Done()
	a.startTextEvents(ctx)
	a.startMail(ctx)
	a.startMonitoring(ctx)
	for i := 0; i < a.Config.WorkerConcurrency; i++ {
		a.workers.Add(1)
		go func() {
			defer a.workers.Done()
			for ctx.Err() == nil {
				task, err := one(ctx, a.DB, "UPDATE generation_tasks SET status='running',worker_token=$1,started_at=coalesce(started_at,now()),deadline=coalesce(deadline,now()+interval '480 seconds') WHERE id=(SELECT id FROM generation_tasks WHERE status='queued' AND available_at<=now() ORDER BY available_at,queued_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *", uuid.NewString())
				if err == nil {
					a.executeTask(ctx, task)
					continue
				}
				if !errors.Is(err, notFound) && ctx.Err() == nil {
					slog.Warn("暂时无法领取任务")
				}
				timer := time.NewTimer(queuePoll)
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}
		}()
	}
	a.workers.Add(1)
	go func() {
		defer a.workers.Done()
		ticker := time.NewTicker(queuePoll)
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
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				a.cleanup(ctx)
			}
		}
	}()
}

func (a *App) executeTask(root context.Context, task Row) {
	ctx := root
	var active bool
	if err := a.DB.QueryRow(ctx, "SELECT status='active' FROM users WHERE id=$1", task["userId"]).Scan(&active); err != nil {
		return
	}
	if !active {
		_ = a.finishTask(ctx, task, nil, nil, &upstreamError{Category: "account_disabled"})
		return
	}
	if err := a.modelAccess(ctx, a.DB, str(task["userId"]), str(task["modelId"])); err != nil {
		_ = a.finishTask(ctx, task, nil, nil, &upstreamError{Category: "model_forbidden"})
		return
	}
	var candidates []channel
	var err error
	resuming := str(task["upstreamTaskId"]) != ""
	if resuming {
		raw, err := a.unseal(str(task["channelSnapshot"]))
		if err != nil {
			_ = a.finishTask(ctx, task, nil, nil, classify(err))
			return
		}
		var saved channel
		if err = json.Unmarshal([]byte(raw), &saved); err != nil {
			_ = a.finishTask(ctx, task, nil, nil, classify(err))
			return
		}
		candidates = []channel{saved}
	} else {
		candidates, err = a.candidates(ctx, str(task["modelId"]))
		if err != nil {
			return
		}
	}
	if len(candidates) == 0 {
		var configured bool
		err = a.DB.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM model_channels b JOIN channels c ON c.id=b.channel_id JOIN models m ON m.id=b.model_id WHERE b.model_id=$1 AND b.enabled AND c.status='active' AND m.status='published' AND m.deleted_at IS NULL)", task["modelId"]).Scan(&configured)
		if err != nil {
			return
		}
		if configured {
			a.requeue(ctx, task, false)
			return
		}
		a.notifyNoChannel(ctx, str(task["modelId"]))
		_ = a.finishTask(ctx, task, nil, nil, &upstreamError{Category: "no_channel"})
		return
	}
	var last *upstreamError
	for _, candidate := range candidates {
		deadline := task["deadline"].(time.Time)
		if !resuming {
			deadline = time.Now().Add(time.Duration(candidate.TimeoutMS) * time.Millisecond)
		}
		acquired, err := a.slot(ctx, candidate, task, deadline)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				_ = a.finishTask(ctx, task, nil, nil, classify(err))
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
				if !keepSlot {
					a.releaseSlot(candidate, task)
				}
			}()
			if !resuming {
				var eligible bool
				if candidate.BindingID != "" {
					err = a.DB.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM model_channels b JOIN channels c ON c.id=b.channel_id JOIN models m ON m.id=b.model_id WHERE b.id=$1 AND b.enabled AND c.status='active' AND m.status='published' AND m.deleted_at IS NULL AND (c.cooldown_until IS NULL OR c.cooldown_until<=now()))", candidate.BindingID).Scan(&eligible)
				} else {
					err = a.DB.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM model_channels b JOIN channels c ON c.id=b.channel_id JOIN models m ON m.id=b.model_id WHERE b.model_id=$1 AND c.id=$2 AND b.enabled AND c.status='active' AND m.status='published' AND m.deleted_at IS NULL AND (c.cooldown_until IS NULL OR c.cooldown_until<=now()))", task["modelId"], candidate.ID).Scan(&eligible)
				}
				if err != nil || !eligible {
					return
				}
			}
			jobCtx, cancel := context.WithDeadline(ctx, deadline)
			defer cancel()
			snapshot, err := a.seal(string(jsonBytes(candidate)))
			if err != nil {
				last = classify(err)
				return
			}
			updated, err := a.DB.Exec(jobCtx, "UPDATE generation_tasks SET deadline=$3,channel_id=$4,channel_snapshot=$5,upstream_model=$6 WHERE id=$1 AND worker_token=$2 AND status='running'", task["id"], task["workerToken"], deadline, candidate.ID, snapshot, candidate.UpstreamModel)
			if err != nil || updated.RowsAffected() != 1 {
				return
			}
			task["deadline"] = deadline
			log, err := one(jobCtx, a.DB, "SELECT id FROM request_logs WHERE task_id=$1 AND status='running' ORDER BY started_at DESC LIMIT 1", task["id"])
			if errors.Is(err, notFound) {
				log, err = one(jobCtx, a.DB, "INSERT INTO request_logs(user_id,type,task_id,model_id,model_name_snapshot,model_display_name_snapshot,channel_id,channel_name_snapshot,upstream_model,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'running') RETURNING id", task["userId"], task["capability"], task["id"], task["modelId"], task["modelName"], task["modelDisplayName"], candidate.ID, candidate.Name, candidate.UpstreamModel)
			}
			if err != nil {
				last = &upstreamError{Category: "storage"}
				return
			}
			if _, err = a.DB.Exec(jobCtx, "INSERT INTO upstream_cost_entries(id,task_id,user_id,model_id,channel_id,capability,cost_config) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING", log["id"], task["id"], task["userId"], task["modelId"], candidate.ID, task["capability"], jsonBytes(candidate.CostConfig)); err != nil {
				last = &upstreamError{Category: "storage"}
				return
			}
			result, err := a.generate(jobCtx, candidate, task)
			if err != nil {
				if resuming && root.Err() != nil {
					a.requeue(context.Background(), task, true)
					keepSlot = true
					task["status"] = "queued"
					return
				}
				last = classify(err)
				if err = a.recordAttemptFailure(ctx, candidate, str(log["id"]), last); err != nil {
					last = &upstreamError{Category: "storage"}
				}
				return
			}
			if result.Pending {
				if result.UpstreamID == "" {
					last = &upstreamError{Category: "upstream_error"}
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
				result, err := tx.Exec(ctx, "UPDATE channels SET last_success_at=now(),last_error_code=NULL,cooldown_until=NULL WHERE id=$1 AND (last_failure_at IS NULL OR last_failure_at<$2) AND (last_error_code IS NOT NULL OR cooldown_until IS NOT NULL)", candidate.ID, task["startedAt"])
				if err != nil || result.RowsAffected() == 0 {
					return err
				}
				return a.notification(ctx, tx, "", "recovered:"+taskReference(task), "channel.recovered", "渠道已恢复", candidate.Name+" 已恢复正常生成。")
			})
		}()
		if task["status"] == "succeeded" || task["status"] == "queued" {
			return
		}
		if last != nil && !last.Retryable {
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
	if err := a.finishTask(finishCtx, task, nil, nil, last); err != nil {
		slog.Warn("任务结算等待恢复", "task", task["id"])
	}
}

func (a *App) requeue(ctx context.Context, task Row, resuming bool) {
	if resuming {
		_, _ = a.DB.Exec(ctx, "UPDATE generation_tasks SET status='queued',worker_token=NULL,available_at=now()+interval '2.5 seconds' WHERE id=$1 AND worker_token=$2 AND status='running'", task["id"], task["workerToken"])
	} else {
		_, _ = a.DB.Exec(ctx, "UPDATE generation_tasks SET status='queued',worker_token=NULL,deadline=NULL,started_at=NULL,available_at=now()+interval '2.5 seconds' WHERE id=$1 AND worker_token=$2 AND status='running'", task["id"], task["workerToken"])
	}
}
func (a *App) recordAttemptFailure(ctx context.Context, c channel, logID string, failure *upstreamError) error {
	return pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "UPDATE upstream_cost_entries SET status='failed',updated_at=now() WHERE id=$1", logID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "UPDATE request_logs SET status='failed',http_status=$2,error_category=$3,error_message=$4,finished_at=now(),duration_ms=(extract(epoch FROM(now()-started_at))*1000)::integer WHERE id=$1", logID, nullableStatus(failure.Status), failure.Category, failure.Error()); err != nil {
			return err
		}
		if failure.Category == "content_policy" || failure.Category == "invalid_request" {
			return nil
		}
		old, err := one(ctx, tx, "SELECT last_error_code FROM channels WHERE id=$1 FOR UPDATE", c.ID)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "UPDATE channels SET last_failure_at=now(),last_error_code=$2,cooldown_until=now()+($3*interval '1 second') WHERE id=$1", c.ID, failure.Category, c.CooldownSeconds); err != nil {
			return err
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
		task, err := one(ctx, tx, "SELECT * FROM generation_tasks WHERE id=$1 FOR UPDATE", original["id"])
		if err != nil {
			return err
		}
		if task["status"] != "running" || task["workerToken"] != original["workerToken"] || integer(task["run"]) != integer(original["run"]) {
			return nil
		}
		// 结算前的最终防护：非文本任务没有媒体结果不允许按成功扣费。
		if failure == nil && task["capability"] != "text" && media == nil {
			failure = &upstreamError{Category: "upstream_error"}
		}
		price := integer(task["priceMicros"])
		status := "succeeded"
		var errorCode, errorMessage, mediaID, messageID any
		var billedMicros, calculatedMicros int64
		var actualSeconds any
		var promptTokens, cachedTokens, completionTokens any
		if failure != nil {
			status = "failed"
			errorCode = failure.Category
			errorMessage = failure.Error()
			if _, err = changeWallet(ctx, tx, str(task["userId"]), "release", taskReference(task), price, -price, "生成失败退回冻结余额"); err != nil {
				return err
			}
		} else {
			if media != nil {
				mediaID = media["id"]
				if err = syncMediaRefs(ctx, tx, "task", str(task["id"]), str(task["userId"]), []string{str(mediaID)}); err != nil {
					return err
				}
			}
			if task["capability"] == "text" {
				if strings.TrimSpace(result.Text) == "" {
					return errors.New("文本结果为空")
				}
				messageID = uuid.NewString()
				if _, err = tx.Exec(ctx, "INSERT INTO messages(id,conversation_id,role,content) VALUES($1,$2,'assistant',$3)", messageID, task["conversationId"], result.Text); err != nil {
					return err
				}
				if _, err = tx.Exec(ctx, "UPDATE conversations SET updated_at=now() WHERE id=$1", task["conversationId"]); err != nil {
					return err
				}
			}
			billedMicros = price
			usageBased := false
			if task["capability"] == "text" {
				promptTokens, cachedTokens, completionTokens = result.PromptTokens, result.CachedTokens, result.CompletionTokens
			}
			if str(task["pricingKind"]) == "token" && task["capability"] == "text" {
				usageBased = true
				promptTokens, cachedTokens, completionTokens = result.PromptTokens, result.CachedTokens, result.CompletionTokens
				cachedPrice := integer(task["cachedPricePerMillion"])
				if task["cachedPricePerMillion"] == nil {
					cachedPrice = integer(task["inputPricePerMillion"])
				}
				// 上游未返回 usage 时回退按冻结额结算，避免按 0 计费。
				if result.PromptTokens > 0 || result.CompletionTokens > 0 {
					billedMicros, err = tokenCost(result.PromptTokens, result.CachedTokens, result.CompletionTokens, integer(task["inputPricePerMillion"]), cachedPrice, integer(task["outputPricePerMillion"]))
					if err != nil {
						return err
					}
				} else {
					usageBased = false
				}
			} else if task["pricePerSecond"] != nil && (task["capability"] == "video" || task["capability"] == "audio") {
				duration := str(task["seconds"])
				if task["capability"] == "audio" && result.DurationSeconds != "" {
					duration = result.DurationSeconds
					actualSeconds = duration
				}
				if seconds, e := decimal.NewFromString(duration); e == nil && seconds.IsPositive() {
					billedMicros, err = roundedMicros(seconds.Mul(decimal.NewFromInt(integer(task["pricePerSecond"]))))
					if err != nil {
						return err
					}
					usageBased = true
				}
			}
			calculatedMicros = billedMicros
			if usageBased {
				// 冻结额只是预估：结算时全额释放冻结，实付与冻结的差额在余额上多退少补；补扣不足时封顶为冻结额。
				charge := billedMicros
				note := "生成成功结算"
				if billedMicros > price {
					var available int64
					if err = tx.QueryRow(ctx, "SELECT balance_micros FROM wallets WHERE user_id=$1", task["userId"]).Scan(&available); err != nil {
						return err
					}
					if available < billedMicros-price {
						charge = price
						note = fmt.Sprintf("生成成功结算（实际费用 %s，余额不足以补扣，按冻结额结算）", money(billedMicros))
					}
				}
				if _, err = changeWallet(ctx, tx, str(task["userId"]), "charge", taskReference(task), price-charge, -price, note); err != nil {
					return err
				}
				billedMicros = charge
			} else if _, err = changeWallet(ctx, tx, str(task["userId"]), "charge", taskReference(task), 0, -price, "生成成功结算"); err != nil {
				return err
			}
		}
		if _, err = tx.Exec(ctx, "UPDATE generation_tasks SET status=$2,output_media_id=$3,response_message_id=$4,error_code=$5,error_message=$6,finished_at=now(),worker_token=NULL,prompt_tokens=$7,cached_tokens=$8,completion_tokens=$9,billed_micros=$10,calculated_micros=$11,seconds=coalesce($12,seconds) WHERE id=$1", task["id"], status, mediaID, messageID, errorCode, errorMessage, promptTokens, cachedTokens, completionTokens, billedMicros, calculatedMicros, actualSeconds); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "UPDATE upstream_cost_entries SET status=$2,updated_at=now() WHERE task_id=$1 AND status='running'", task["id"], status); err != nil {
			return err
		}
		billed := "0"
		if failure == nil {
			billed = money(billedMicros)
		}
		_, err = tx.Exec(ctx, "UPDATE request_logs SET status=$2,error_category=$3,error_message=$4,billed_amount=$5,finished_at=now(),duration_ms=(extract(epoch FROM(now()-started_at))*1000)::integer,first_token_ms=(SELECT (extract(epoch FROM(first_token_at-started_at))*1000)::integer FROM generation_tasks WHERE id=$1),output_tokens=$6 WHERE task_id=$1 AND status='running'", task["id"], status, errorCode, errorMessage, billed, integer(completionTokens))
		return err
	})
	if err == nil && original["capability"] == "text" {
		a.publishText(ctx, str(original["id"]))
	}
	if err == nil && failure == nil {
		_ = a.notifyLowBalance(ctx, a.DB, str(original["userId"]))
	}
	return err
}
func (a *App) recoverTasks(ctx context.Context) {
	tasks, err := rows(ctx, a.DB, "SELECT * FROM generation_tasks WHERE status='running' AND deadline<now() ORDER BY deadline LIMIT 100")
	if err != nil {
		return
	}
	for _, task := range tasks {
		if err = a.finishTask(ctx, task, nil, nil, &upstreamError{Category: "timeout"}); err != nil {
			slog.Warn("恢复任务结算失败", "task", task["id"])
		}
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

func (a *App) cleanup(ctx context.Context) {
	_, _ = a.DB.Exec(ctx, "DELETE FROM auth_tokens WHERE expires_at<now()")
	_, _ = a.DB.Exec(ctx, "DELETE FROM mail_outbox WHERE created_at<now()-($1*interval '1 day') AND status IN('sent','failed')", a.Config.LogDays)
	_, _ = a.DB.Exec(ctx, "DELETE FROM sessions WHERE expires_at<now()")
	_, _ = a.DB.Exec(ctx, "DELETE FROM request_logs WHERE started_at<now()-($1*interval '1 day') AND status<>'running'", a.Config.LogDays)
	_, _ = a.DB.Exec(ctx, "DELETE FROM channel_checks WHERE created_at<now()-($1*interval '1 day')", checkRetentionDays)
	_, _ = a.DB.Exec(ctx, "DELETE FROM notifications WHERE created_at<now()-($1*interval '1 day')", notificationRetentionDays)
	_, _ = a.DB.Exec(ctx, "DELETE FROM audit_logs WHERE created_at<now()-($1*interval '1 day') AND action<>'cost.reconciled'", auditRetentionDays)
	items, err := rows(ctx, a.DB, "SELECT id FROM media_objects WHERE created_at<now()-($1*interval '1 day') AND NOT EXISTS(SELECT 1 FROM media_references WHERE media_id=media_objects.id) AND NOT EXISTS(SELECT 1 FROM generation_tasks WHERE output_media_id=media_objects.id) AND NOT EXISTS(SELECT 1 FROM assets WHERE media_id=media_objects.id)", a.Config.OrphanDays)
	if err != nil {
		return
	}
	for _, item := range items {
		var key string
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			row, err := one(ctx, tx, "SELECT * FROM media_objects WHERE id=$1 FOR UPDATE", item["id"])
			if err != nil {
				return err
			}
			var referenced bool
			if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM media_references WHERE media_id=$1) OR EXISTS(SELECT 1 FROM generation_tasks WHERE output_media_id=$1) OR EXISTS(SELECT 1 FROM assets WHERE media_id=$1)", item["id"]).Scan(&referenced); err != nil {
				return err
			}
			if referenced {
				return notFound
			}
			key = str(row["objectKey"])
			_, err = tx.Exec(ctx, "UPDATE media_objects SET status='deleting' WHERE id=$1", item["id"])
			return err
		})
		if err != nil {
			continue
		}
		if err = a.S3.RemoveObject(ctx, a.Config.Bucket, key, minio.RemoveObjectOptions{}); err != nil {
			continue
		}
		_, _ = a.DB.Exec(ctx, "DELETE FROM media_objects WHERE id=$1 AND status='deleting'", item["id"])
	}
}
