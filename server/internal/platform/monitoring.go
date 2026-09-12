package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"net/http"
	"net/url"
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
	AutoDisableAfter int            `json:"autoDisableAfter" binding:"min=0"`
	BindingIDs       []string       `json:"bindingIds,omitempty" binding:"omitempty,dive,uuid"`
	Prompt           string         `json:"prompt"`
	Parameters       map[string]any `json:"parameters"`
	CheckModels      bool           `json:"checkModels"`
	BalanceThreshold *string        `json:"balanceThreshold"`
}

func (a *App) channelModels(ctx context.Context, c channel) (names []string, err error) {
	started := time.Now()
	defer func() {
		if err != nil {
			_ = recordKeyFailure(context.WithoutCancel(ctx), a.DB, c, classify(err))
		} else {
			_ = recordKeySuccess(context.WithoutCancel(ctx), a.DB, c, started)
		}
	}()
	names = []string{}
	seen, cursors := map[string]bool{}, map[string]bool{}
	path := "models"
	for {
		req, err := http.NewRequestWithContext(ctx, "GET", c.endpoint(path), nil)
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
		if c.Protocol != "anthropic" || data["has_more"] != true {
			break
		}
		cursor := str(data["last_id"])
		if cursor == "" || cursors[cursor] {
			return nil, &upstreamError{Category: "upstream_error", Message: "上游模型列表分页未推进"}
		}
		cursors[cursor] = true
		path = "models?after_id=" + url.QueryEscape(cursor)
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
		input, err := body[Monitoring](c, Monitoring{AutoDisableAfter: 3})
		if err != nil {
			return nil, err
		}
		if len(input.BindingIDs) > 0 && strings.TrimSpace(input.Prompt) == "" {
			return nil, problem(400, "invalid_probe", "请填写生成检测的提示词")
		}
		if input.BalanceThreshold != nil {
			value, e := decimal.NewFromString(*input.BalanceThreshold)
			if e != nil || value.IsNegative() {
				return nil, problem(400, "invalid_balance", "余额提醒阈值必须为非负数")
			}
		}
		if input.IntervalMinutes > 0 && len(input.BindingIDs) == 0 && !input.CheckModels && input.BalanceThreshold == nil {
			return nil, problem(400, "invalid_probe", "请至少选择一个检测项目")
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if len(input.BindingIDs) > 0 {
				var protocol string
				if err := tx.QueryRow(ctx, "SELECT protocol FROM channels WHERE id=$1 AND deleted_at IS NULL FOR SHARE", id).Scan(&protocol); err != nil {
					return err
				}
				if protocol == "anthropic" && explicitTextTokens(input.Parameters) == 0 {
					return problem(400, "output_limit_required", "Claude 生成检测必须指定最大输出 token 数")
				}
				var count int
				if err := tx.QueryRow(ctx, "SELECT count(*) FROM model_channels b JOIN models m ON m.id=b.model_id WHERE b.channel_id=$1 AND b.id=ANY($2::text[]::uuid[]) AND m.deleted_at IS NULL", id, input.BindingIDs).Scan(&count); err != nil {
					return err
				}
				if count != len(input.BindingIDs) {
					return problem(400, "invalid_probe", "请先将检测模型绑定到此渠道")
				}
			}
			result, err := tx.Exec(ctx, "UPDATE channels SET monitoring=$2,next_check_at=CASE WHEN $3::int>0 THEN now() ELSE NULL END,auto_disabled_at=CASE WHEN $4::int=0 THEN NULL ELSE auto_disabled_at END,consecutive_check_failures=0,updated_at=now() WHERE id=$1 AND deleted_at IS NULL", id, jsonBytes(input), input.IntervalMinutes, input.AutoDisableAfter)
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
			row, err := one(ctx, tx, "SELECT status,monitoring FROM channels WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", id)
			if err != nil {
				return err
			}
			if row["status"] != "active" {
				return problem(409, "channel_disabled", "请先启用渠道")
			}
			var config Monitoring
			_ = json.Unmarshal(jsonBytes(row["monitoring"]), &config)
			if len(config.BindingIDs) == 0 && !config.CheckModels && config.BalanceThreshold == nil {
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
	admin.POST("/playground/test", respond(a.playgroundTest))
}

func (a *App) runProbe(ctx context.Context, ch channel, task Row) (result generationResult, err error) {
	started := time.Now()
	id := str(task["id"])
	deadline, _ := ctx.Deadline()
	if _, err = a.DB.Exec(ctx, "INSERT INTO upstream_cost_entries(id,user_id,model_id,channel_id,capability,cost_config,note,monitor_token,deadline,key_id,binding_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", id, task["userId"], task["modelId"], ch.ID, task["capability"], jsonBytes(ch.CostConfig), task["note"], task["monitorToken"], deadline, nullable(ch.KeyID), nullable(ch.BindingID)); err != nil {
		return result, &upstreamError{Category: "storage"}
	}
	defer func() {
		status := "succeeded"
		if err != nil {
			status = "failed"
			_ = recordKeyFailure(context.WithoutCancel(ctx), a.DB, ch, classify(err))
		} else {
			_ = recordKeySuccess(context.WithoutCancel(ctx), a.DB, ch, started)
		}
		_, saveErr := a.DB.Exec(context.WithoutCancel(ctx), "UPDATE upstream_cost_entries SET status=$2,duration_ms=(extract(epoch FROM(now()-created_at))*1000)::bigint,updated_at=now() WHERE id=$1", id, status)
		if err == nil && saveErr != nil {
			err = &upstreamError{Category: "storage"}
		}
	}()
	result, err = a.generate(ctx, ch, task)
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
	if err != nil {
		return result, err
	}
	if task["capability"] == "audio" && ch.CostConfig["second"] != nil {
		result.DurationSeconds, _ = audioDuration(ctx, result.Data)
	}
	if err = a.recordCost(context.WithoutCancel(ctx), id, result, object(task["parameters"])["seconds"], ch.CostConfig); err != nil {
		return result, &upstreamError{Category: "storage"}
	}
	if task["capability"] != "text" && len(result.Data) == 0 {
		return result, &upstreamError{Category: "invalid_result", Message: "上游未返回媒体结果"}
	}
	if task["capability"] == "image" {
		if _, _, err = image.DecodeConfig(bytes.NewReader(result.Data)); err != nil {
			return result, &upstreamError{Category: "invalid_result", Message: "上游未返回可解码的图片"}
		}
	}
	return result, ctx.Err()
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
	config := monitoringConfig(row["monitoring"])
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
	canProbe := a.selectChannelKey(ctx, &ch, nil, true) == nil
	validHealth := false
	bindingChecks := []Row{}
	if !canProbe {
		status, detail["credentials"] = "failed", "没有可检测的密钥，请检查密钥配置"
	}
	if probes := config.BindingIDs; canProbe && len(probes) > 0 {
		details := []string{}
		for i, bindingID := range probes {
			binding, err := one(ctx, a.DB, "SELECT b.model_id,m.capability,b.upstream_model,b.cost_config FROM model_channels b JOIN models m ON m.id=b.model_id WHERE b.id=$1 AND b.channel_id=$2 AND m.deleted_at IS NULL", bindingID, id)
			if err != nil {
				status = "failed"
				details = append(details, "检测模型绑定已失效")
				continue
			}
			ch.UpstreamModel = str(binding["upstreamModel"])
			ch.BindingID = bindingID
			ch.CostConfig = object(binding["costConfig"])
			// 检测的全部成本记录共用 monitor_token，中断恢复时才能一并关联。
			costID := token
			if i > 0 {
				costID = uuid.NewString()
			}
			task := Row{"id": costID, "run": 1, "probe": true, "modelId": binding["modelId"], "monitorToken": token, "note": "渠道生成检测", "capability": binding["capability"], "prompt": config.Prompt, "parameters": config.Parameters}
			probeStarted := time.Now()
			_, err = a.runProbe(ctx, ch, task)
			checkStatus := "healthy"
			category := ""
			if err != nil {
				status = "failed"
				checkStatus = "failed"
				currentFailure := classify(err)
				category = currentFailure.Category
				if channelFailure(currentFailure) {
					failure = currentFailure
					validHealth = true
				}
				details = append(details, str(binding["upstreamModel"])+" 生成检测失败（"+currentFailure.Category+"）")
			} else {
				validHealth = true
				details = append(details, str(binding["upstreamModel"])+" 生成成功")
			}
			if err == nil || channelFailure(classify(err)) {
				bindingChecks = append(bindingChecks, Row{"id": bindingID, "status": checkStatus, "category": nullable(category), "duration": time.Since(probeStarted).Milliseconds(), "started": probeStarted})
			}
		}
		if len(details) > 0 {
			detail["generation"] = strings.Join(details, "；")
		}
	}
	if config.CheckModels && canProbe {
		models, err = a.channelModels(ctx, ch)
		if err != nil {
			status = "failed"
			detail["models"] = "模型列表读取失败"
			if currentFailure := classify(err); channelFailure(currentFailure) {
				failure = currentFailure
				validHealth = true
			}
		} else {
			validHealth = true
			detail["modelCount"] = len(models)
			if row["upstreamModels"] != nil {
				changes = modelChanges(row["upstreamModels"], models)
			}
		}
	}
	if config.BalanceThreshold != nil && canProbe {
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
		for _, check := range bindingChecks {
			if _, err = tx.Exec(root, `INSERT INTO channel_binding_checks(binding_id,status,duration_ms,checked_at,error_category) SELECT id,$2,$3,$4,$5 FROM model_channels WHERE id=$1
				ON CONFLICT(binding_id) DO UPDATE SET status=excluded.status,duration_ms=excluded.duration_ms,checked_at=excluded.checked_at,error_category=excluded.error_category
				WHERE channel_binding_checks.checked_at<excluded.checked_at`, check["id"], check["status"], check["duration"], check["started"], check["category"]); err != nil {
				return err
			}
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
		if validHealth {
			if err = a.recordMonitorHealth(root, tx, current, started, status == "healthy", failure); err != nil {
				return err
			}
			if status == "healthy" {
				if err = recordKeySuccess(root, tx, ch, started); err != nil {
					return err
				}
			}
		}
		if str(current["monitorStatus"]) != status && (status == "failed" || current["monitorStatus"] != nil) && !(status == "healthy" && current["autoDisabledAt"] != nil) {
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
				row, err := one(ctx, a.DB, "UPDATE channels SET monitor_token=$1,monitor_deadline=now()+(timeout_ms*interval '1 millisecond'),next_check_at=CASE WHEN coalesce((monitoring->>'intervalMinutes')::int,0)>0 THEN now()+((monitoring->>'intervalMinutes')::int*interval '1 minute') ELSE NULL END WHERE id=(SELECT id FROM channels WHERE status='active' AND deleted_at IS NULL AND next_check_at<=now() AND monitor_token IS NULL AND (cooldown_until IS NULL OR cooldown_until<=now()) ORDER BY next_check_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *", uuid.NewString())
				if err == nil {
					a.runMonitor(ctx, row)
				}
			}
		}
	}()
}

func (a *App) recoverMonitoring(ctx context.Context) {
	_ = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		stale, err := rows(ctx, tx, "SELECT * FROM channels WHERE monitor_token IS NOT NULL AND monitor_deadline<now() FOR UPDATE SKIP LOCKED")
		if err != nil {
			return err
		}
		for _, row := range stale {
			if err = a.recordMonitorHealth(ctx, tx, row, time.Now(), false, &upstreamError{Category: "timeout"}); err != nil {
				return err
			}
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
