package platform

import (
	"time"

	"github.com/gin-gonic/gin"
)

// statusCacheTTL 是模型状态页的缓存时间：聚合查询覆盖 24 小时任务，避免每次请求都重算。
const statusCacheTTL = 60 * time.Second

func (a *App) cachedStatus() (any, bool) {
	a.statusMu.Lock()
	defer a.statusMu.Unlock()
	if a.statusCache == nil || time.Since(a.statusAt) >= statusCacheTTL {
		return nil, false
	}
	return a.statusCache, true
}

func (a *App) storeStatus(value any) {
	a.statusMu.Lock()
	defer a.statusMu.Unlock()
	a.statusCache, a.statusAt = value, time.Now()
}

func (a *App) publicStatus(c *gin.Context) (any, error) {
	c.Header("Cache-Control", "no-store")
	if cached, ok := a.cachedStatus(); ok {
		return cached, nil
	}
	ctx := c.Request.Context()
	items, err := rows(ctx, a.DB, `WITH health AS (
		SELECT b.model_id,b.channel_id,c.capability,
			CASE WHEN c.status<>'active' OR c.auto_disabled_at IS NOT NULL OR c.cooldown_until>now()
				OR NOT EXISTS(SELECT 1 FROM channel_keys k WHERE k.channel_id=c.id AND k.status='active') THEN 'unavailable'
			ELSE 'available' END AS state
		FROM model_channels b JOIN channels c ON c.id=b.channel_id
		WHERE b.enabled AND c.deleted_at IS NULL
	)
	SELECT m.id,m.display_name,m.capability,
		count(DISTINCT h.channel_id) FILTER(WHERE h.state='available') AS available_channels,
		CASE WHEN count(*) FILTER(WHERE h.state='available')>0 THEN
			CASE WHEN count(*) FILTER(WHERE h.state<>'available')>0 THEN 'degraded' ELSE 'available' END
		ELSE 'unavailable' END AS status
	FROM models m LEFT JOIN health h ON h.model_id=m.id AND h.capability=m.capability WHERE m.status='published' AND m.deleted_at IS NULL
	GROUP BY m.id ORDER BY m.sort_order,m.created_at`)
	if err != nil {
		return nil, err
	}
	// 以任务最终结果为可用性口径：故障转移后成功记为成功；内容拒绝、参数错误等非平台故障不计入。
	stats, err := rows(ctx, a.DB, `SELECT model_id,count(*) AS total,count(*) FILTER(WHERE status='succeeded') AS ok
		FROM generation_tasks WHERE finished_at>now()-interval '24 hours'
			AND (status='succeeded' OR (status='failed' AND coalesce(error_code,'') NOT IN('content_policy','invalid_request','canceled','account_disabled','model_forbidden','storage_quota','insufficient_balance','moderation_rejected')))
		GROUP BY model_id`)
	if err != nil {
		return nil, err
	}
	checks, err := rows(ctx, a.DB, `SELECT model_id,status,(extract(epoch FROM(finished_at-started_at))*1000)::bigint AS duration_ms,finished_at FROM(
		SELECT model_id,status,started_at,finished_at,row_number() OVER(PARTITION BY model_id ORDER BY finished_at DESC) rn
		FROM generation_tasks WHERE finished_at>now()-interval '24 hours'
			AND (status='succeeded' OR (status='failed' AND coalesce(error_code,'') NOT IN('content_policy','invalid_request','canceled','account_disabled','model_forbidden','storage_quota','insufficient_balance','moderation_rejected')))) t
		WHERE rn<=40 ORDER BY finished_at`)
	if err != nil {
		return nil, err
	}
	uptime, totals, history := map[string]float64{}, map[string]int64{}, map[string][]Row{}
	for _, row := range stats {
		if total := integer(row["total"]); total > 0 {
			uptime[str(row["modelId"])] = float64(integer(row["ok"])) / float64(total)
			totals[str(row["modelId"])] = total
		}
	}
	for _, row := range checks {
		id := str(row["modelId"])
		history[id] = append(history[id], row)
	}
	for _, item := range items {
		id := str(item["id"])
		if list := history[id]; list != nil {
			item["checks"] = list
		} else {
			item["checks"] = []Row{}
		}
		if value, ok := uptime[id]; ok {
			item["uptime"] = value
			item["taskCount"] = totals[id]
		}
	}
	result := gin.H{"models": items}
	a.storeStatus(result)
	return result, nil
}
