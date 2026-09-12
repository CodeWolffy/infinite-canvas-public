package platform

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
)

func monitoringConfig(value any) Monitoring {
	config := Monitoring{AutoDisableAfter: 3}
	_ = json.Unmarshal(jsonBytes(value), &config)
	return config
}

func channelFailure(failure *upstreamError) bool {
	if failure == nil {
		return false
	}
	switch failure.Category {
	case "authentication", "rate_limit", "timeout", "upstream_error", "stream_interrupted":
		return true
	}
	return false
}

// 手动状态独立于自动停用；只有有效的检测结果才推进失败计数或恢复。
func (a *App) recordMonitorHealth(ctx context.Context, tx pgx.Tx, row Row, started time.Time, success bool, failure *upstreamError) error {
	if !success && !channelFailure(failure) {
		return nil
	}
	if failure != nil && failure.Category == "authentication" {
		var otherKeys bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM channel_keys WHERE channel_id=$1 AND status='active')", row["id"]).Scan(&otherKeys); err != nil {
			return err
		}
		if otherKeys {
			return nil
		}
	}
	config := monitoringConfig(row["monitoring"])
	if success {
		result, err := tx.Exec(ctx, `UPDATE channels SET consecutive_check_failures=0,auto_disabled_at=NULL,last_success_at=now(),last_error_code=NULL,cooldown_until=NULL
			WHERE id=$1 AND (last_failure_at IS NULL OR last_failure_at<$2)`, row["id"], started)
		if err != nil || result.RowsAffected() == 0 || row["autoDisabledAt"] == nil {
			return err
		}
		return a.notification(ctx, tx, "", "auto-recovered:"+str(row["monitorToken"]), "channel.recovered", "渠道已自动恢复", str(row["name"])+" 检测成功，已恢复接单。")
	}
	count := integer(row["consecutiveCheckFailures"]) + 1
	disable := config.AutoDisableAfter > 0 && count >= int64(config.AutoDisableAfter)
	if _, err := tx.Exec(ctx, `UPDATE channels SET consecutive_check_failures=$2,last_failure_at=now(),last_error_code=$3,
		cooldown_until=now()+(cooldown_seconds*interval '1 second'),auto_disabled_at=CASE WHEN $4 THEN coalesce(auto_disabled_at,now()) ELSE auto_disabled_at END WHERE id=$1`, row["id"], count, failure.Category, disable); err != nil {
		return err
	}
	if disable && row["autoDisabledAt"] == nil {
		return a.notification(ctx, tx, "", "auto-disabled:"+str(row["monitorToken"]), "channel.disabled", "渠道已自动停用", str(row["name"])+" 连续检测失败，暂时停止接单；后续检测成功后自动恢复。")
	}
	return nil
}
