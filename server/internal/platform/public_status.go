package platform

import (
	"github.com/gin-gonic/gin"
)

func (a *App) publicStatus(c *gin.Context) (any, error) {
	c.Header("Cache-Control", "no-store")
	items, err := rows(c.Request.Context(), a.DB, `WITH health AS (
		SELECT b.model_id,b.channel_id,h.checked_at,
			CASE WHEN c.status<>'active' OR c.auto_disabled_at IS NOT NULL OR c.cooldown_until>now()
				OR NOT EXISTS(SELECT 1 FROM channel_keys k WHERE k.channel_id=c.id AND k.status='active') THEN 'unavailable'
			WHEN h.binding_id IS NULL OR (coalesce((c.monitoring->>'intervalMinutes')::int,0)>0
				AND h.checked_at+((c.monitoring->>'intervalMinutes')::int*interval '1 minute')<now()) THEN 'unknown'
			WHEN h.error_category='authentication' THEN 'unknown'
			WHEN h.status='healthy' THEN 'available' ELSE 'unavailable' END AS state
		FROM model_channels b JOIN channels c ON c.id=b.channel_id LEFT JOIN channel_binding_checks h ON h.binding_id=b.id
		WHERE b.enabled AND c.deleted_at IS NULL
	)
	SELECT m.id,m.display_name,m.capability,max(h.checked_at) AS checked_at,
		count(DISTINCT h.channel_id) FILTER(WHERE h.state='available') AS available_channels,
		CASE WHEN count(*) FILTER(WHERE h.state='available')>0 THEN
			CASE WHEN count(*) FILTER(WHERE h.state<>'available')>0 THEN 'degraded' ELSE 'available' END
		WHEN count(*) FILTER(WHERE h.state='unknown')>0 THEN 'unknown' ELSE 'unavailable' END AS status
	FROM models m LEFT JOIN health h ON h.model_id=m.id WHERE m.status='published' AND m.deleted_at IS NULL
	GROUP BY m.id ORDER BY m.sort_order,m.created_at`)
	return gin.H{"models": items}, err
}
