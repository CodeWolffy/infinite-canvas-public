package platform

import (
	"encoding/json"
)

func monitoringConfig(value any) Monitoring {
	var config Monitoring
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

// 真实流量里只有确定性故障才计入自动停用：限流靠冷却自愈，鉴权失败由 Key 状态处理。
func channelRequestFailure(category string) bool {
	switch category {
	case "timeout", "upstream_error", "stream_interrupted":
		return true
	}
	return false
}

// 连续失败按 2 的幂延长冷却，封顶 8 倍；成功一次即回落一档。
func cooldownBackoff(count int64) int64 {
	backoff := int64(1)
	for i := int64(1); i < count && backoff < 8; i++ {
		backoff *= 2
	}
	return backoff
}
