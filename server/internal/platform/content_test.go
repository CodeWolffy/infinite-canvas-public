package platform

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func canvasTestSnapshot(mediaID string) map[string]any {
	node := map[string]any{"id": "n1", "type": "image", "metadata": map[string]any{}}
	if mediaID != "" {
		node["metadata"] = map[string]any{"storageKey": "image:" + mediaID}
	}
	return map[string]any{
		"nodes":       []any{node},
		"connections": []any{},
		"viewport":    map[string]any{"x": 0.0, "y": 0.0, "k": 1.0},
	}
}

// 画布项目：创建、保存快照与视口、历史裁剪到 20 条、删除后释放媒体引用。
func TestCanvasProjectLifecycle(t *testing.T) {
	a := testApp(t)
	userID, cookie := testUser(t, a, 0)
	ctx := context.Background()
	mediaID := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO media_objects(id,owner_id,object_key,original_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,'ref.png','image/png',1,'hash')", mediaID, userID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	created := testRequest(router, "POST", "/api/canvas-projects", map[string]any{"title": "测试画布", "snapshot": canvasTestSnapshot(mediaID)}, cookie)
	if created.Code != 200 {
		t.Fatalf("创建画布失败: %d %s", created.Code, created.Body.String())
	}
	projectID := str(object(responseRow(t, created)["project"])["id"])
	var refs int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM media_references WHERE owner_kind='canvas' AND owner_id=$1", projectID).Scan(&refs); err != nil || refs != 1 {
		t.Fatalf("画布应登记 1 条媒体引用: %d %v", refs, err)
	}

	saved := testRequest(router, "PUT", "/api/canvas-projects/"+projectID, map[string]any{"viewport": map[string]any{"x": 12.0, "y": 34.0, "k": 1.5}}, cookie)
	if saved.Code != 200 {
		t.Fatalf("保存视口失败: %d %s", saved.Code, saved.Body.String())
	}
	viewport, err := one(ctx, a.DB, "SELECT snapshot->'viewport' AS viewport FROM canvas_projects WHERE id=$1", projectID)
	if err != nil {
		t.Fatal(err)
	}
	got := object(viewport["viewport"])
	if got["x"] != 12.0 || got["k"] != 1.5 {
		t.Fatalf("视口未保存: %v", got)
	}

	// 历史超过 20 条时只保留最新的 20 条；用历史时间规避 5 分钟内的合并窗口。
	for i := 0; i < 25; i++ {
		if _, err = a.DB.Exec(ctx, "INSERT INTO canvas_project_history(project_id,user_id,title,snapshot,created_at) VALUES($1,$2,'旧版本',$3,now()-($4*interval '1 hour'))", projectID, userID, jsonBytes(canvasTestSnapshot(mediaID)), i+1); err != nil {
			t.Fatal(err)
		}
	}
	snapshot := canvasTestSnapshot(mediaID)
	snapshot["nodes"] = []any{map[string]any{"id": "n2", "type": "text", "metadata": map[string]any{}}}
	if saved = testRequest(router, "PUT", "/api/canvas-projects/"+projectID, map[string]any{"snapshot": snapshot}, cookie); saved.Code != 200 {
		t.Fatalf("保存快照失败: %d %s", saved.Code, saved.Body.String())
	}
	var history int
	if err = a.DB.QueryRow(ctx, "SELECT count(*) FROM canvas_project_history WHERE project_id=$1", projectID).Scan(&history); err != nil || history != 20 {
		t.Fatalf("历史应裁剪到 20 条: %d %v", history, err)
	}
	// 新快照不再引用原媒体，画布引用应被同步清掉。
	if err = a.DB.QueryRow(ctx, "SELECT count(*) FROM media_references WHERE owner_kind='canvas' AND owner_id=$1", projectID).Scan(&refs); err != nil || refs != 0 {
		t.Fatalf("新快照应释放旧媒体引用: %d %v", refs, err)
	}

	if deleted := testRequest(router, "DELETE", "/api/canvas-projects/"+projectID, nil, cookie); deleted.Code != 204 {
		t.Fatalf("删除画布失败: %d %s", deleted.Code, deleted.Body.String())
	}
	var projects int
	if err = a.DB.QueryRow(ctx, "SELECT count(*) FROM canvas_projects WHERE id=$1", projectID).Scan(&projects); err != nil || projects != 0 {
		t.Fatalf("画布未删除: %d %v", projects, err)
	}
	var orphans int
	if err = a.DB.QueryRow(ctx, "SELECT count(*) FROM canvas_project_history h WHERE h.project_id=$1 AND NOT EXISTS(SELECT 1 FROM canvas_projects p WHERE p.id=h.project_id)", projectID).Scan(&orphans); err != nil || orphans != 0 {
		t.Fatalf("删除画布后不应残留历史记录: %d %v", orphans, err)
	}
}

// 素材增删改查必须按所有者隔离：其他用户读、改、删都不应成功。
func TestAssetCRUDIsolatesOwners(t *testing.T) {
	a := testApp(t)
	_, ownerCookie := testUser(t, a, 0)
	_, otherCookie := testUser(t, a, 0)
	ctx := context.Background()
	router := a.Router()
	created := testRequest(router, "POST", "/api/assets", map[string]any{"type": "text", "title": "我的素材", "content": "hello"}, ownerCookie)
	if created.Code != 200 {
		t.Fatalf("创建素材失败: %d %s", created.Code, created.Body.String())
	}
	assetID := str(object(responseRow(t, created)["asset"])["id"])
	updated := testRequest(router, "PUT", "/api/assets/"+assetID, map[string]any{"type": "text", "title": "改名素材", "content": "world"}, ownerCookie)
	if updated.Code != 200 {
		t.Fatalf("更新素材失败: %d %s", updated.Code, updated.Body.String())
	}
	if title := str(object(responseRow(t, updated)["asset"])["title"]); title != "改名素材" {
		t.Fatalf("素材标题未更新: %s", title)
	}
	// 越权访问返回 404：既拒绝操作，也不泄露资源是否存在。
	for _, request := range []struct {
		method, path string
		body         any
	}{
		{"GET", "/api/assets/" + assetID, nil},
		{"PUT", "/api/assets/" + assetID, map[string]any{"type": "text", "title": "被篡改", "content": "hacked"}},
		{"DELETE", "/api/assets/" + assetID, nil},
	} {
		response := testRequest(router, request.method, request.path, request.body, otherCookie)
		if response.Code != 404 {
			t.Fatalf("越权 %s %s 应返回 404，实际 %d", request.method, request.path, response.Code)
		}
	}
	var title string
	if err := a.DB.QueryRow(ctx, "SELECT title FROM assets WHERE id=$1", assetID).Scan(&title); err != nil || title != "改名素材" {
		t.Fatalf("越权请求改动了素材: %s %v", title, err)
	}
	if deleted := testRequest(router, "DELETE", "/api/assets/"+assetID, nil, ownerCookie); deleted.Code != 204 {
		t.Fatalf("删除素材失败: %d %s", deleted.Code, deleted.Body.String())
	}
	var assets int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM assets WHERE id=$1", assetID).Scan(&assets); err != nil || assets != 0 {
		t.Fatalf("素材未删除: %d %v", assets, err)
	}
}
