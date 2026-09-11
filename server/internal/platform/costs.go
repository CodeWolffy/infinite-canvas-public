package platform

import (
	"context"
	"os"
	"os/exec"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

func validateCosts(config map[string]string) error {
	for key, value := range config {
		if key != "fixed" && key != "input" && key != "cached" && key != "output" && key != "second" {
			return problem(400, "invalid_cost", "不支持的成本字段")
		}
		amount, err := amountUnits(value, moneyScale)
		if err != nil {
			return err
		}
		if amount < 0 {
			return problem(400, "invalid_cost", "渠道成本不能为负数")
		}
	}
	_, input := config["input"]
	_, output := config["output"]
	if input != output {
		return problem(400, "invalid_cost", "请同时配置输入和输出 token 成本")
	}
	_, fixed := config["fixed"]
	_, second := config["second"]
	if len(config) > 0 && !input && !fixed && !second {
		return problem(400, "invalid_cost", "请配置一种完整的成本方式")
	}
	if input && (fixed || second) || fixed && second {
		return problem(400, "invalid_cost", "请选择一种成本方式")
	}
	return nil
}

func costAmount(config map[string]any, result generationResult, seconds any) (*int64, error) {
	prices := map[string]int64{}
	for key, value := range config {
		n, err := amountUnits(str(value), moneyScale)
		if err != nil {
			return nil, err
		}
		prices[key] = n
	}
	var amount int64
	var err error
	if input, ok := prices["input"]; ok {
		if result.PromptTokens == 0 && result.CompletionTokens == 0 {
			return nil, nil
		}
		cached, ok := prices["cached"]
		if !ok {
			cached = input
		}
		amount, err = tokenCost(result.PromptTokens, result.CachedTokens, result.CompletionTokens, input, cached, prices["output"])
	} else if second, ok := prices["second"]; ok {
		if result.DurationSeconds != "" {
			seconds = result.DurationSeconds
		}
		duration, e := decimal.NewFromString(str(seconds))
		if e != nil || !duration.IsPositive() {
			return nil, nil
		}
		amount, err = roundedMicros(duration.Mul(decimal.NewFromInt(second)))
	} else if fixed, ok := prices["fixed"]; ok {
		amount = fixed
	} else {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &amount, nil
}

func audioDuration(ctx context.Context, data []byte) (string, error) {
	file, err := os.CreateTemp("", "canvas-duration-*")
	if err != nil {
		return "", err
	}
	name := file.Name()
	defer os.Remove(name)
	if _, err = file.Write(data); err != nil {
		_ = file.Close()
		return "", err
	}
	if err = file.Close(); err != nil {
		return "", err
	}
	output, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", "mp3,wav,ogg,flac,aac,mov", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", name).Output()
	if err != nil {
		return "", problem(502, "duration_unavailable", "无法读取音频时长，请检查服务器 ffprobe 配置")
	}
	seconds, err := decimal.NewFromString(strings.TrimSpace(string(output)))
	if err != nil || !seconds.IsPositive() {
		return "", problem(502, "duration_unavailable", "音频未包含有效时长")
	}
	return seconds.String(), nil
}

func (a *App) recordCost(ctx context.Context, id string, result generationResult, seconds any, config map[string]any) error {
	amount, err := costAmount(config, result, seconds)
	if err != nil {
		return err
	}
	source := "unknown"
	if amount != nil {
		source = "configured"
	}
	_, err = a.DB.Exec(ctx, "UPDATE upstream_cost_entries SET amount_micros=$2,source=$3,updated_at=now() WHERE id=$1 AND source<>'actual'", id, amount, source)
	return err
}

func (a *App) costRoutes(admin *gin.RouterGroup) {
	admin.PUT("/models/:id/bindings/:bindingId/cost", respond(func(c *gin.Context) (any, error) {
		model, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		bindingID, err := idParam(c, "bindingId")
		if err != nil {
			return nil, err
		}
		config, err := body[map[string]string](c)
		if err != nil {
			return nil, err
		}
		if err = validateCosts(config); err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			result, err := tx.Exec(ctx, "UPDATE model_channels SET cost_config=$3,updated_at=now() WHERE model_id=$1 AND id=$2", model, bindingID, jsonBytes(config))
			if err != nil {
				return err
			}
			if result.RowsAffected() != 1 {
				return notFound
			}
			return a.audit(ctx, tx, currentUser(c).ID, "binding.cost", model+":"+bindingID, config)
		})
		return nil, err
	}))
	admin.PUT("/models/:id/channels/:channelId/cost", respond(func(c *gin.Context) (any, error) {
		model, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		channel, err := idParam(c, "channelId")
		if err != nil {
			return nil, err
		}
		config, err := body[map[string]string](c)
		if err != nil {
			return nil, err
		}
		if err = validateCosts(config); err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			result, err := tx.Exec(ctx, "UPDATE model_channels SET cost_config=$3,updated_at=now() WHERE model_id=$1 AND channel_id=$2", model, channel, jsonBytes(config))
			if err != nil {
				return err
			}
			if result.RowsAffected() == 0 {
				return notFound
			}
			return a.audit(ctx, tx, currentUser(c).ID, "channel.cost", model+":"+channel, config)
		})
		return nil, err
	}))
	admin.GET("/costs", respond(func(c *gin.Context) (any, error) {
		from, err := queryTime(c, "from")
		if err != nil {
			return nil, err
		}
		to, err := queryTime(c, "to")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		limit, offset := pagination(c)
		source, modelID, channelID := c.Query("source"), c.Query("modelId"), c.Query("channelId")
		if (modelID != "" && !validID(modelID)) || (channelID != "" && !validID(channelID)) {
			return nil, problem(400, "invalid_id", "记录编号不正确")
		}
		filter := "($1::timestamptz IS NULL OR e.created_at>=$1) AND ($2::timestamptz IS NULL OR e.created_at<=$2) AND ($3='' OR e.source=$3) AND ($4='' OR e.model_id::text=$4) AND ($5='' OR e.channel_id::text=$5)"
		totals, err := one(ctx, a.DB, "SELECT coalesce(sum(e.amount_micros),0)::bigint AS known_cost,count(*) FILTER(WHERE e.amount_micros IS NULL)::bigint AS unknown_count,count(*) FILTER(WHERE e.source='actual')::bigint AS reconciled_count FROM upstream_cost_entries e WHERE "+filter, from, to, source, modelID, channelID)
		if err != nil {
			return nil, err
		}
		// 实付与成本使用同一筛选范围归集，按任务去重避免故障转移的多条成本记录重复计入实付。
		var paid int64
		if err = a.DB.QueryRow(ctx, `SELECT coalesce(-sum(t.billed_micros),0)::bigint FROM generation_tasks t
			WHERE ($1::timestamptz IS NULL OR t.finished_at>=$1) AND ($2::timestamptz IS NULL OR t.finished_at<=$2)
			AND ($4='' OR t.model_id::text=$4) AND ($5='' OR t.channel_id::text=$5)
			AND ($3='' OR EXISTS(SELECT 1 FROM upstream_cost_entries e2 WHERE e2.task_id=t.id AND e2.source=$3))
			AND ($3<>'' OR $4<>'' OR $5<>'' OR t.id IN(SELECT task_id FROM upstream_cost_entries))`, from, to, source, modelID, channelID).Scan(&paid); err != nil {
			return nil, err
		}
		var grants int64
		if err = a.DB.QueryRow(ctx, "SELECT coalesce(sum(delta_balance) FILTER(WHERE kind IN('grant','checkin')),0)::bigint FROM wallet_entries WHERE ($1::timestamptz IS NULL OR created_at>=$1) AND ($2::timestamptz IS NULL OR created_at<=$2)", from, to).Scan(&grants); err != nil {
			return nil, err
		}
		known := integer(totals["knownCost"])
		totals["knownCost"], totals["userPaid"], totals["subsidy"], totals["grants"] = money(known), money(paid), money(max(known-paid, 0)), money(grants)
		items, err := rows(ctx, a.DB, "SELECT e.*,m.display_name AS model_name,c.name AS channel_name,u.username,t.billed_micros AS user_paid FROM upstream_cost_entries e LEFT JOIN models m ON m.id=e.model_id JOIN channels c ON c.id=e.channel_id LEFT JOIN users u ON u.id=e.user_id LEFT JOIN generation_tasks t ON t.id=e.task_id WHERE "+filter+" ORDER BY e.created_at DESC,e.id LIMIT $6 OFFSET $7", from, to, source, modelID, channelID, limit, offset)
		for _, item := range items {
			if item["amountMicros"] != nil {
				item["amount"] = money(integer(item["amountMicros"]))
			}
			item["userPaid"] = money(integer(item["userPaid"]))
			delete(item, "amountMicros")
			delete(item, "costConfig")
		}
		return gin.H{"totals": totals, "entries": items}, err
	}))
	admin.PUT("/costs/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			Amount string `json:"amount" binding:"required"`
			Note   string `json:"note" binding:"required"`
		}](c)
		if err != nil {
			return nil, err
		}
		amount, err := amountUnits(input.Amount, moneyScale)
		if err != nil {
			return nil, err
		}
		if amount < 0 || strings.TrimSpace(input.Note) == "" {
			return nil, problem(400, "invalid_cost", "请填写非负实际成本和核对依据")
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			before, err := one(ctx, tx, "SELECT amount_micros,source FROM upstream_cost_entries WHERE id=$1 FOR UPDATE", id)
			if err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "UPDATE upstream_cost_entries SET amount_micros=$2,source='actual',note=$3,updated_at=now() WHERE id=$1", id, amount, input.Note); err != nil {
				return err
			}
			return a.audit(ctx, tx, currentUser(c).ID, "cost.reconciled", id, Row{"before": before, "amount": input.Amount, "note": input.Note})
		})
		return nil, err
	}))
}
