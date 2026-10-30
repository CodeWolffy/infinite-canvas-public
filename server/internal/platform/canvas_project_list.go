package platform

import (
	"strings"

	"github.com/gin-gonic/gin"
)

// 封面只返回图片节点已有的本地媒体地址，且必须登记在当前画布的授权引用中。
// 当前主图优先；不读取文件、不抓取远程地址，也不向客户端发送完整快照。
const canvasProjectPreview = `,
	(SELECT '/api/media/' || m.id::text
	 FROM jsonb_array_elements(snapshot->'nodes') WITH ORDINALITY AS n(value,position)
	 CROSS JOIN LATERAL (
		SELECT image.value,image.position,CASE WHEN image.value->>'id'=n.value#>>'{metadata,primaryImageId}' THEN 0 ELSE 1 END AS priority
		FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.value#>'{metadata,images}')='array' THEN n.value#>'{metadata,images}' ELSE '[]'::jsonb END) WITH ORDINALITY AS image(value,position)
		UNION ALL SELECT n.value->'metadata',0,2
	 ) AS image
	 JOIN media_references mr ON mr.owner_kind='canvas' AND mr.owner_id=canvas_projects.id
	 JOIN media_objects m ON m.id=mr.media_id AND m.status='ready' AND m.mime_type LIKE 'image/%'
	 WHERE n.value->>'type'='image' AND (
		m.id::text=regexp_replace(coalesce(image.value->>'storageKey',''),'^(image|media):','')
		OR position('/api/media/' || m.id::text IN coalesce(image.value->>'content',''))>0)
	 ORDER BY n.position,image.priority,image.position LIMIT 1) AS cover_url,
	(SELECT n->>'type' FROM jsonb_array_elements(snapshot->'nodes') AS n
	 WHERE n->>'type' IN('image','text','video','audio','config') LIMIT 1) AS preview_type`

func canvasProjectFilter(c *gin.Context, visible, userID string) (string, []any, string, error) {
	where, args := "("+visible+")", []any{userID}
	if keyword := strings.TrimSpace(c.Query("keyword")); keyword != "" {
		args = append(args, keyword)
		where += " AND position(lower($" + str(len(args)) + ") IN lower(title))>0"
	}
	if workspace := strings.TrimSpace(c.Query("workspaceId")); workspace != "" {
		if workspace == "personal" {
			where += " AND workspace_id IS NULL"
		} else {
			if !validID(workspace) {
				return "", nil, "", problem(400, "invalid_workspace", "工作区编号不正确")
			}
			args = append(args, workspace)
			where += " AND workspace_id=$" + str(len(args))
		}
	}
	order := "updated_at DESC,id DESC"
	switch c.DefaultQuery("sort", "updated_desc") {
	case "updated_desc":
	case "created_desc":
		order = "created_at DESC,id DESC"
	case "created_asc":
		order = "created_at ASC,id ASC"
	case "title_asc":
		order = "title ASC,id ASC"
	default:
		return "", nil, "", problem(400, "invalid_sort", "画布排序方式不正确")
	}
	return where, args, order, nil
}
