package platform

import "github.com/gin-gonic/gin"

const userTaskRelations = ` FROM generation_tasks t
	LEFT JOIN generation_batches b ON b.id=t.batch_id AND b.user_id=t.user_id
	LEFT JOIN conversations cv ON cv.id=t.conversation_id AND cv.user_id=t.user_id`

// 列表和计数共用同一范围；文本及无批次任务不能因 INNER JOIN 批次而遗漏。
const userTaskScope = ` WHERE t.user_id=$1
	AND (t.batch_id IS NULL OR (b.id IS NOT NULL AND b.deleted_at IS NULL))
	AND ($2='' OR t.capability=$2)`

const userTaskStatusFilter = `($3='' OR t.status=$3)`

func userTaskView(row Row) Row {
	if str(row["sourceUnavailable"]) != "" {
		// 保留本人任务的状态和费用，撤权来源中的内容及媒体不能继续展示。
		for _, key := range []string{"prompt", "batchId", "conversationId", "canvasProjectId", "sourceTitle", "errorMessage", "outputMediaId"} {
			row[key] = nil
		}
	}
	return taskView(row)
}

func (a *App) userTaskRoutes(api *gin.RouterGroup) {
	api.GET("/generation-tasks", respond(func(c *gin.Context) (any, error) {
		capability, status := c.Query("capability"), c.Query("status")
		switch capability {
		case "", "image", "video", "audio", "text":
		default:
			return nil, problem(400, "invalid_capability", "任务类型不正确")
		}
		switch status {
		case "", "reviewing", "queued", "running", "succeeded", "failed", "canceled":
		default:
			return nil, problem(400, "invalid_status", "任务状态不正确")
		}
		ctx, userID := c.Request.Context(), currentUser(c).ID
		limit, offset := pagination(c)
		var total, reviewing, queued, running int
		// 概况与分页、状态筛选无关，仍遵守本人、模态及批次删除条件。
		if err := a.DB.QueryRow(ctx, `SELECT count(*) FILTER(WHERE `+userTaskStatusFilter+`),
			count(*) FILTER(WHERE t.status='reviewing'),count(*) FILTER(WHERE t.status='queued'),count(*) FILTER(WHERE t.status='running')`+userTaskRelations+userTaskScope, userID, capability, status).Scan(&total, &reviewing, &queued, &running); err != nil {
			return nil, err
		}
		items, err := rows(ctx, a.DB, `SELECT t.id,t.batch_id,t.capability,t.status,t.sequence,t.queued_at,t.started_at,t.finished_at,
			t.model_display_name,t.conversation_id,t.prompt,t.error_code,t.error_message,t.price_micros,t.billed_micros,
			m.id AS output_media_id,m.mime_type,m.byte_size,m.width,m.height,
			coalesce(b.canvas_project_id,cv.canvas_project_id) AS canvas_project_id,coalesce(p.title,cv.title) AS source_title,
			CASE WHEN (t.capability='text' OR t.conversation_id IS NOT NULL) AND (cv.id IS NULL OR cv.deleted_at IS NOT NULL) THEN 'conversation'
				WHEN coalesce(b.canvas_project_id,cv.canvas_project_id) IS NOT NULL AND p.id IS NULL THEN 'canvas'
				ELSE NULL END AS source_unavailable`+userTaskRelations+`
			LEFT JOIN canvas_projects p ON p.id=coalesce(b.canvas_project_id,cv.canvas_project_id)
				AND (p.user_id=$1 OR EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=p.workspace_id AND wm.user_id=$1))
			LEFT JOIN media_objects m ON m.id=t.output_media_id AND m.owner_id=t.user_id AND m.status='ready'`+userTaskScope+` AND `+userTaskStatusFilter+`
			ORDER BY t.queued_at DESC,t.id DESC LIMIT $4 OFFSET $5`, userID, capability, status, limit, offset)
		if err != nil {
			return nil, err
		}
		for _, task := range items {
			userTaskView(task)
		}
		return gin.H{"tasks": items, "total": total, "limit": limit, "offset": offset, "summary": gin.H{"reviewing": reviewing, "queued": queued, "running": running}}, nil
	}))
}
