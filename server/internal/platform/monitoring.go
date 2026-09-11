package platform

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

type Monitoring struct {
	IntervalMinutes  int            `json:"intervalMinutes" binding:"min=0"`
	ModelID          string         `json:"modelId" binding:"omitempty,uuid"`
	ModelIDs         []string       `json:"modelIds,omitempty" binding:"omitempty,dive,uuid"`
	Prompt           string         `json:"prompt"`
	Parameters       map[string]any `json:"parameters"`
	CheckModels      bool           `json:"checkModels"`
	BalanceThreshold *string        `json:"balanceThreshold"`
}

func (a *App) channelModels(ctx context.Context, c channel) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.endpoint("models"), nil)
	if err != nil {
		return nil, err
	}
	c.authorize(req)
	data, err := a.upstreamJSON(req)
	if err != nil {
		return nil, err
	}
	list, _ := data["data"].([]any)
	if c.Protocol == "gemini" {
		list, _ = data["models"].([]any)
	}
	names := []string{}
	seen := map[string]bool{}
	for _, item := range list {
		model := object(item)
		name := str(model["id"])
		if c.Protocol == "gemini" {
			name = strings.TrimPrefix(str(model["name"]), "models/")
		}
		if name != "" && !seen[name] {
			names = append(names, name)
			seen[name] = true
		}
	}
	sort.Strings(names)
	return names, nil
}

func (a *App) channelBalance(ctx context.Context, c channel) (Row, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.endpoint("dashboard/billing/subscription"), nil)
	if err != nil {
		return nil, err
	}
	c.authorize(req)
	subscription, err := a.upstreamJSON(req)
	if err != nil {
		return nil, err
	}
	quota, ok := toFloat(subscription["hard_limit_usd"])
	if !ok {
		return nil, problem(502, "balance_unavailable", "渠道未返回可识别的额度")
	}
	result := Row{"quota": quota}
	req, err = http.NewRequestWithContext(ctx, "GET", c.endpoint("dashboard/billing/usage"), nil)
	if err != nil {
		return nil, err
	}
	c.authorize(req)
	usage, err := a.upstreamJSON(req)
	if err == nil {
		if spent, ok := toFloat(usage["total_usage"]); ok {
			result["used"] = spent / 100
			result["balance"] = quota - spent/100
		}
	}
	return result, nil
}

func (a *App) monitoringRoutes(admin *gin.RouterGroup) {
	admin.GET("/channels/:id/bindings", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		items, err := rows(c.Request.Context(), a.DB, "SELECT b.id,m.id AS model_id,m.display_name,m.capability,b.upstream_model FROM model_channels b JOIN models m ON m.id=b.model_id WHERE b.channel_id=$1 AND m.deleted_at IS NULL ORDER BY m.sort_order,m.created_at", id)
		return gin.H{"models": items}, err
	}))
	admin.PUT("/channels/:id/monitoring", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		input, err := body[Monitoring](c)
		if err != nil {
			return nil, err
		}
		if len(input.probeIDs()) > 0 && strings.TrimSpace(input.Prompt) == "" {
			return nil, problem(400, "invalid_probe", "请填写生成检测的提示词")
		}
		if input.BalanceThreshold != nil {
			value, e := decimal.NewFromString(*input.BalanceThreshold)
			if e != nil || value.IsNegative() {
				return nil, problem(400, "invalid_balance", "余额提醒阈值必须为非负数")
			}
		}
		if input.IntervalMinutes > 0 && len(input.probeIDs()) == 0 && !input.CheckModels && input.BalanceThreshold == nil {
			return nil, problem(400, "invalid_probe", "请至少选择一个检测项目")
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if len(input.probeIDs()) > 0 {
				var count int
				if err := tx.QueryRow(ctx, "SELECT count(DISTINCT model_id) FROM model_channels WHERE channel_id=$1 AND model_id=ANY($2::text[]::uuid[])", id, input.probeIDs()).Scan(&count); err != nil {
					return err
				}
				if count != len(input.probeIDs()) {
					return problem(400, "invalid_probe", "请先将检测模型绑定到此渠道")
				}
			}
			result, err := tx.Exec(ctx, "UPDATE channels SET monitoring=$2,next_check_at=CASE WHEN $3::int>0 THEN now() ELSE NULL END,updated_at=now() WHERE id=$1", id, jsonBytes(input), input.IntervalMinutes)
			if err != nil {
				return err
			}
			if result.RowsAffected() != 1 {
				return notFound
			}
			return a.audit(ctx, tx, currentUser(c).ID, "channel.monitoring", id, input)
		})
		return nil, err
	}))
	admin.POST("/channels/:id/check", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			row, err := one(ctx, tx, "SELECT status,monitoring FROM channels WHERE id=$1 FOR UPDATE", id)
			if err != nil {
				return err
			}
			if row["status"] != "active" {
				return problem(409, "channel_disabled", "请先启用渠道")
			}
			var config Monitoring
			_ = json.Unmarshal(jsonBytes(row["monitoring"]), &config)
			if len(config.probeIDs()) == 0 && !config.CheckModels && config.BalanceThreshold == nil {
				return problem(400, "invalid_probe", "请先配置检测项目")
			}
			if _, err = tx.Exec(ctx, "UPDATE channels SET next_check_at=now() WHERE id=$1", id); err != nil {
				return err
			}
			return a.audit(ctx, tx, currentUser(c).ID, "channel.check_requested", id, Row{})
		})
		return gin.H{"queued": true}, err
	}))
	admin.GET("/channels/:id/checks", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		limit, offset := pagination(c)
		items, err := rows(c.Request.Context(), a.DB, "SELECT id,status,detail,duration_ms,created_at FROM channel_checks WHERE channel_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3", id, limit, offset)
		return gin.H{"checks": items}, err
	}))
	admin.POST("/channels/:id/model-changes/ack", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		_, err = a.DB.Exec(c.Request.Context(), "UPDATE channels SET model_changes=NULL WHERE id=$1", id)
		return nil, err
	}))
}

func modelChanges(previous any, current []string) Row {
	var old []string
	_ = json.Unmarshal(jsonBytes(previous), &old)
	oldSet, newSet := map[string]bool{}, map[string]bool{}
	for _, name := range old {
		oldSet[name] = true
	}
	for _, name := range current {
		newSet[name] = true
	}
	added, removed := []string{}, []string{}
	for _, name := range current {
		if !oldSet[name] {
			added = append(added, name)
		}
	}
	for _, name := range old {
		if !newSet[name] {
			removed = append(removed, name)
		}
	}
	if len(added)+len(removed) == 0 {
		return nil
	}
	return Row{"added": added, "removed": removed}
}

func (a *App) runMonitor(root context.Context, row Row) {
	started := time.Now()
	id, token := str(row["id"]), str(row["monitorToken"])
	ctx, cancel := context.WithDeadline(root, row["monitorDeadline"].(time.Time))
	defer cancel()
	var config Monitoring
	_ = json.Unmarshal(jsonBytes(row["monitoring"]), &config)
	ch, err := a.channelFromRow(row)
	if err != nil {
		return
	}
	probe := Row{"id": token, "run": 1}
	acquired, err := a.slot(ctx, ch, probe, row["monitorDeadline"].(time.Time))
	if err != nil || !acquired {
		_, _ = a.DB.Exec(root, "UPDATE channels SET monitor_token=NULL,monitor_deadline=NULL,next_check_at=now()+interval '2.5 seconds' WHERE id=$1 AND monitor_token=$2", id, token)
		return
	}
	defer a.releaseSlot(ch, probe)
	status := "healthy"
	detail := Row{}
	var models []string
	var changes Row
	var balance any
	balanceStatus := str(row["balanceStatus"])
	var failure *upstreamError
	if probes := config.probeIDs(); len(probes) > 0 {
		details := []string{}
		for i, modelID := range probes {
			binding, err := one(ctx, a.DB, "SELECT m.capability,b.upstream_model,b.cost_config FROM model_channels b JOIN models m ON m.id=b.model_id WHERE b.model_id=$1 AND b.channel_id=$2 AND m.deleted_at IS NULL ORDER BY b.priority DESC, b.created_at ASC LIMIT 1", modelID, id)
			if err != nil {
				status = "failed"
				details = append(details, "检测模型绑定已失效")
				continue
			}
			ch.UpstreamModel = str(binding["upstreamModel"])
			ch.CostConfig = object(binding["costConfig"])
			// 检测的全部成本记录共用 monitor_token，中断恢复时才能一并关联。
			costID := token
			if i > 0 {
				costID = uuid.NewString()
			}
			task := Row{"id": costID, "run": 1, "probe": true, "capability": binding["capability"], "prompt": config.Prompt, "parameters": config.Parameters}
			_, err = a.DB.Exec(ctx, "INSERT INTO upstream_cost_entries(id,model_id,channel_id,capability,cost_config,note,monitor_token) VALUES($1,$2,$3,$4,$5,'渠道生成检测',$6)", costID, modelID, id, binding["capability"], jsonBytes(ch.CostConfig), token)
			var result generationResult
			if err == nil {
				result, err = a.generate(ctx, ch, task)
			}
			for err == nil && result.Pending {
				task["upstreamTaskId"] = result.UpstreamID
				timer := time.NewTimer(queuePoll)
				select {
				case <-ctx.Done():
					timer.Stop()
					err = ctx.Err()
				case <-timer.C:
					result, err = a.generate(ctx, ch, task)
				}
			}
			if err == nil && binding["capability"] == "audio" && ch.CostConfig["second"] != nil {
				result.DurationSeconds, _ = audioDuration(ctx, result.Data)
			}
			if err == nil {
				err = a.recordCost(ctx, costID, result, config.Parameters["seconds"], ch.CostConfig)
			}
			if err != nil {
				status = "failed"
				failure = classify(err)
				details = append(details, str(binding["upstreamModel"])+" 生成检测失败（"+failure.Category+"）")
			} else {
				details = append(details, str(binding["upstreamModel"])+" 生成成功")
			}
			_, _ = a.DB.Exec(root, "UPDATE upstream_cost_entries SET status=$2,updated_at=now() WHERE id=$1", costID, map[bool]string{true: "succeeded", false: "failed"}[err == nil])
		}
		if len(details) > 0 {
			detail["generation"] = strings.Join(details, "；")
		}
	}
	if config.CheckModels {
		models, err = a.channelModels(ctx, ch)
		if err != nil {
			status = "failed"
			detail["models"] = "模型列表读取失败"
		} else {
			detail["modelCount"] = len(models)
			if row["upstreamModels"] != nil {
				changes = modelChanges(row["upstreamModels"], models)
			}
		}
	}
	if config.BalanceThreshold != nil {
		info, err := a.channelBalance(ctx, ch)
		balanceStatus = "unavailable"
		if err == nil && info["balance"] != nil {
			balance = fmt.Sprint(info["balance"])
			balanceStatus = "ok"
			threshold, _ := decimal.NewFromString(*config.BalanceThreshold)
			value, _ := decimal.NewFromString(str(balance))
			if value.LessThanOrEqual(threshold) {
				balanceStatus = "low"
			}
		} else {
			detail["balance"] = "渠道未返回可用余额，未按零余额处理"
		}
	}
	_ = pgx.BeginFunc(root, a.DB, func(tx pgx.Tx) error {
		current, err := one(root, tx, "SELECT * FROM channels WHERE id=$1 AND monitor_token=$2 FOR UPDATE", id, token)
		if errors.Is(err, notFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if _, err = tx.Exec(root, "UPDATE channels SET monitor_token=NULL,monitor_deadline=NULL WHERE id=$1", id); err != nil {
			return err
		}
		if !current["updatedAt"].(time.Time).Equal(row["updatedAt"].(time.Time)) {
			return nil
		}
		if _, err = tx.Exec(root, "INSERT INTO channel_checks(id,channel_id,status,detail,duration_ms) VALUES($1,$2,$3,$4,$5)", token, id, status, jsonBytes(detail), time.Since(started).Milliseconds()); err != nil {
			return err
		}
		var changeJSON, errorText any
		if changes != nil {
			changeJSON = jsonBytes(changes)
		}
		if status == "failed" {
			errorText = detail["generation"]
			if errorText == nil {
				errorText = detail["models"]
			}
		}
		if _, err = tx.Exec(root, "UPDATE channels SET monitor_status=$2,monitor_error=$3,monitor_checked_at=now(),upstream_models=coalesce($4::text[],upstream_models),model_changes=coalesce($5,model_changes),upstream_balance=coalesce($6,upstream_balance),balance_status=$7 WHERE id=$1", id, status, errorText, models, changeJSON, balance, nullable(balanceStatus)); err != nil {
			return err
		}
		if failure != nil && failure.Category != "content_policy" && failure.Category != "invalid_request" {
			if _, err = tx.Exec(root, "UPDATE channels SET cooldown_until=now()+($2*interval '1 second'),last_failure_at=now(),last_error_code=$3 WHERE id=$1", id, ch.CooldownSeconds, failure.Category); err != nil {
				return err
			}
		}
		if status == "healthy" && len(config.probeIDs()) > 0 {
			if _, err = tx.Exec(root, "UPDATE channels SET last_success_at=now(),last_error_code=NULL,cooldown_until=NULL WHERE id=$1 AND (last_failure_at IS NULL OR last_failure_at<$2)", id, started); err != nil {
				return err
			}
		}
		if str(current["monitorStatus"]) != status && (status == "failed" || current["monitorStatus"] != nil) {
			if err = a.notification(root, tx, "", "monitor:"+token, "channel.health", "渠道检测状态变化", ch.Name+"："+map[string]string{"healthy": "已恢复", "failed": "检测失败，请查看检测记录"}[status]); err != nil {
				return err
			}
		}
		if changes != nil {
			if err = a.notification(root, tx, "", "models:"+token, "channel.models", "上游模型列表发生变化", ch.Name+" 的模型有新增或移除，请在渠道页面核对绑定。"); err != nil {
				return err
			}
		}
		if balanceStatus != str(current["balanceStatus"]) && (balanceStatus == "low" || balanceStatus == "unavailable") {
			return a.notification(root, tx, "", "balance:"+token, "channel.balance", "渠道余额提醒", ch.Name+map[string]string{"low": "：余额已达到设置的提醒阈值", "unavailable": "：暂时无法查询余额，请检查渠道支持情况"}[balanceStatus])
		}
		return nil
	})
}

func (a *App) startMonitoring(ctx context.Context) {
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
				a.recoverMonitoring(ctx)
				row, err := one(ctx, a.DB, "UPDATE channels SET monitor_token=$1,monitor_deadline=now()+(timeout_ms*interval '1 millisecond'),next_check_at=CASE WHEN coalesce((monitoring->>'intervalMinutes')::int,0)>0 THEN now()+((monitoring->>'intervalMinutes')::int*interval '1 minute') ELSE NULL END WHERE id=(SELECT id FROM channels WHERE status='active' AND next_check_at<=now() AND monitor_token IS NULL AND (cooldown_until IS NULL OR cooldown_until<=now()) ORDER BY next_check_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *", uuid.NewString())
				if err == nil {
					a.runMonitor(ctx, row)
				}
			}
		}
	}()
}

func (a *App) recoverMonitoring(ctx context.Context) {
	_ = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		stale, err := rows(ctx, tx, "SELECT id,name,monitor_token,monitor_status FROM channels WHERE monitor_token IS NOT NULL AND monitor_deadline<now() FOR UPDATE SKIP LOCKED")
		if err != nil {
			return err
		}
		for _, row := range stale {
			if _, err = tx.Exec(ctx, "INSERT INTO channel_checks(id,channel_id,status,detail,duration_ms) VALUES($1,$2,'failed',$3,0) ON CONFLICT(id) DO NOTHING", row["monitorToken"], row["id"], jsonBytes(Row{"generation": "检测超时或进程中断，未重新提交原请求"})); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "UPDATE upstream_cost_entries SET status='failed',updated_at=now() WHERE monitor_token=$1 AND status='running'", row["monitorToken"]); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "UPDATE channels SET monitor_token=NULL,monitor_deadline=NULL,monitor_status='failed',monitor_error='检测超时或进程中断',monitor_checked_at=now() WHERE id=$1", row["id"]); err != nil {
				return err
			}
			if str(row["monitorStatus"]) != "failed" {
				if err = a.notification(ctx, tx, "", "monitor:"+str(row["monitorToken"]), "channel.health", "渠道检测未完成", str(row["name"])+"：检测超时或进程中断，请检查检测记录。"); err != nil {
					return err
				}
			}
		}
		return nil
	})
}
