package platform

import (
	"context"
	"net/http"
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
	createdProject := object(responseRow(t, created)["project"])
	projectID := str(createdProject["id"])
	if createdProject["revision"] != float64(0) {
		t.Fatalf("新画布版本应为 0: %v", createdProject["revision"])
	}
	var refs int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM media_references WHERE owner_kind='canvas' AND owner_id=$1", projectID).Scan(&refs); err != nil || refs != 1 {
		t.Fatalf("画布应登记 1 条媒体引用: %d %v", refs, err)
	}

	saved := testRequest(router, "PUT", "/api/canvas-projects/"+projectID, map[string]any{"viewport": map[string]any{"x": 12.0, "y": 34.0, "k": 1.5}, "expectedRevision": 0}, cookie)
	if saved.Code != 200 {
		t.Fatalf("保存视口失败: %d %s", saved.Code, saved.Body.String())
	}
	if revision := object(responseRow(t, saved)["project"])["revision"]; revision != float64(1) {
		t.Fatalf("视口保存应推进版本到 1: %v", revision)
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
	if saved = testRequest(router, "PUT", "/api/canvas-projects/"+projectID, map[string]any{"snapshot": snapshot, "expectedRevision": 1}, cookie); saved.Code != 200 {
		t.Fatalf("保存快照失败: %d %s", saved.Code, saved.Body.String())
	}
	if revision := object(responseRow(t, saved)["project"])["revision"]; revision != float64(2) {
		t.Fatalf("快照保存应推进版本到 2: %v", revision)
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

func TestCanvasProjectPutRejectsUnauthorized(t *testing.T) {
	a := testApp(t)
	ownerID, ownerCookie := testUser(t, a, 0)
	viewerID, viewerCookie := testUser(t, a, 0)
	_, otherCookie := testUser(t, a, 0)
	ctx := context.Background()
	router := a.Router()
	workspaceID := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO workspaces(id,name,owner_id) VALUES($1,'共享工作区',$2)", workspaceID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer')", workspaceID, ownerID, viewerID); err != nil {
		t.Fatal(err)
	}
	created := testRequest(router, "POST", "/api/canvas-projects", map[string]any{"title": "原画布", "snapshot": canvasTestSnapshot(""), "workspaceId": workspaceID}, ownerCookie)
	if created.Code != 200 {
		t.Fatalf("创建画布失败: %d %s", created.Code, created.Body.String())
	}
	projectID := str(object(responseRow(t, created)["project"])["id"])
	for _, attempt := range []struct {
		name, id string
		cookie   *http.Cookie
	}{
		{"无权限用户", projectID, otherCookie},
		{"只读成员", projectID, viewerCookie},
		{"不存在的画布", uuid.NewString(), ownerCookie},
	} {
		response := testRequest(router, "PUT", "/api/canvas-projects/"+attempt.id, map[string]any{"title": "被篡改", "snapshot": canvasTestSnapshot(""), "expectedRevision": 0}, attempt.cookie)
		if response.Code != 404 {
			t.Fatalf("%s 保存画布应返回 404，实际 %d %s", attempt.name, response.Code, response.Body.String())
		}
	}
	var title string
	var history int
	if err := a.DB.QueryRow(ctx, "SELECT title FROM canvas_projects WHERE id=$1", projectID).Scan(&title); err != nil || title != "原画布" {
		t.Fatalf("越权请求改动了画布: %s %v", title, err)
	}
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM canvas_project_history WHERE project_id=$1", projectID).Scan(&history); err != nil || history != 0 {
		t.Fatalf("越权请求创建了画布历史: %d %v", history, err)
	}
}

func TestCanvasProjectPutMovesWorkspaceAndSavesPriorSnapshot(t *testing.T) {
	a := testApp(t)
	ownerID, ownerCookie := testUser(t, a, 0)
	editorID, editorCookie := testUser(t, a, 0)
	ctx := context.Background()
	router := a.Router()
	workspaceID := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO workspaces(id,name,owner_id) VALUES($1,'目标工作区',$2)", workspaceID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'editor')", workspaceID, ownerID, editorID); err != nil {
		t.Fatal(err)
	}
	created := testRequest(router, "POST", "/api/canvas-projects", map[string]any{"title": "原画布", "snapshot": canvasTestSnapshot("")}, ownerCookie)
	if created.Code != 200 {
		t.Fatalf("创建画布失败: %d %s", created.Code, created.Body.String())
	}
	projectID := str(object(responseRow(t, created)["project"])["id"])
	prior := canvasTestSnapshot("")
	next := canvasTestSnapshot("")
	next["nodes"] = []any{map[string]any{"id": "n2", "type": "text", "metadata": map[string]any{}}}
	updated := testRequest(router, "PUT", "/api/canvas-projects/"+projectID, map[string]any{"workspaceId": workspaceID, "snapshot": next, "expectedRevision": 0}, ownerCookie)
	if updated.Code != 200 {
		t.Fatalf("移动并保存画布失败: %d %s", updated.Code, updated.Body.String())
	}
	if got := str(object(responseRow(t, updated)["project"])["workspaceId"]); got != workspaceID {
		t.Fatalf("响应中的工作区未更新: %s", got)
	}
	if revision := object(responseRow(t, updated)["project"])["revision"]; revision != float64(1) {
		t.Fatalf("合并工作区与快照写入应只推进一次版本: %v", revision)
	}
	project, err := one(ctx, a.DB, "SELECT workspace_id,snapshot FROM canvas_projects WHERE id=$1", projectID)
	if err != nil {
		t.Fatal(err)
	}
	if str(project["workspaceId"]) != workspaceID || string(jsonBytes(project["snapshot"])) != string(jsonBytes(next)) {
		t.Fatalf("画布工作区或快照未持久化: %v", project)
	}
	history, err := rows(ctx, a.DB, "SELECT title,snapshot FROM canvas_project_history WHERE project_id=$1", projectID)
	if err != nil || len(history) != 1 {
		t.Fatalf("应保存一条更新前的历史: %v %v", history, err)
	}
	if str(history[0]["title"]) != "原画布" || string(jsonBytes(history[0]["snapshot"])) != string(jsonBytes(prior)) {
		t.Fatalf("历史未保存更新前的快照: %v", history[0])
	}
	if response := testRequest(router, "PUT", "/api/canvas-projects/"+projectID, map[string]any{"workspaceId": ""}, editorCookie); response.Code != 403 {
		t.Fatalf("编辑者移动画布应返回 403，实际 %d %s", response.Code, response.Body.String())
	}
	var stillWorkspace string
	if err := a.DB.QueryRow(ctx, "SELECT workspace_id FROM canvas_projects WHERE id=$1", projectID).Scan(&stillWorkspace); err != nil || stillWorkspace != workspaceID {
		t.Fatalf("编辑者改动了工作区: %s %v", stillWorkspace, err)
	}
}

func TestCanvasProjectRevisionConflictPreservesCommittedSnapshot(t *testing.T) {
	a := testApp(t)
	ownerID, ownerCookie := testUser(t, a, 0)
	editorID, editorCookie := testUser(t, a, 0)
	ctx := context.Background()
	router := a.Router()
	workspaceID := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO workspaces(id,name,owner_id) VALUES($1,'协作工作区',$2)", workspaceID, ownerID); err != nil {
		t.Fatal(err)
	}
	// 第二个写入者是同一工作区的编辑者，两人从同一个版本开始编辑。
	if _, err := a.DB.Exec(ctx, "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'editor')", workspaceID, ownerID, editorID); err != nil {
		t.Fatal(err)
	}
	created := testRequest(router, "POST", "/api/canvas-projects", map[string]any{"title": "协作画布", "snapshot": canvasTestSnapshot(""), "workspaceId": workspaceID}, ownerCookie)
	if created.Code != 200 {
		t.Fatalf("创建画布失败: %d %s", created.Code, created.Body.String())
	}
	projectID := str(object(responseRow(t, created)["project"])["id"])
	first := canvasTestSnapshot("")
	first["nodes"] = []any{map[string]any{"id": "owner-node", "type": "text", "metadata": map[string]any{}}}
	second := canvasTestSnapshot("")
	second["nodes"] = []any{map[string]any{"id": "editor-node", "type": "text", "metadata": map[string]any{}}}
	committed := testRequest(router, "PUT", "/api/canvas-projects/"+projectID, map[string]any{"snapshot": first, "expectedRevision": 0}, ownerCookie)
	if committed.Code != 200 || object(responseRow(t, committed)["project"])["revision"] != float64(1) {
		t.Fatalf("首个写入应成功并推进版本: %d %s", committed.Code, committed.Body.String())
	}
	conflict := testRequest(router, "PUT", "/api/canvas-projects/"+projectID, map[string]any{"snapshot": second, "expectedRevision": 0}, editorCookie)
	if conflict.Code != 409 || responseRow(t, conflict)["error"] != "canvas_revision_conflict" {
		t.Fatalf("过期快照应返回版本冲突: %d %s", conflict.Code, conflict.Body.String())
	}
	stored, err := one(ctx, a.DB, "SELECT snapshot,revision FROM canvas_projects WHERE id=$1", projectID)
	if err != nil || string(jsonBytes(stored["snapshot"])) != string(jsonBytes(first)) || integer(stored["revision"]) != 1 {
		t.Fatalf("冲突不得覆盖已提交快照: %v %v", stored, err)
	}
	missing := testRequest(router, "PUT", "/api/canvas-projects/"+projectID, map[string]any{"snapshot": second}, editorCookie)
	if missing.Code != 400 {
		t.Fatalf("内容编辑缺少版本应拒绝: %d %s", missing.Code, missing.Body.String())
	}
	move := testRequest(router, "PUT", "/api/canvas-projects/"+projectID, map[string]any{"workspaceId": ""}, ownerCookie)
	if move.Code != 200 || object(responseRow(t, move)["project"])["revision"] != float64(2) {
		t.Fatalf("工作区移动无需版本但仍须推进版本: %d %s", move.Code, move.Body.String())
	}
	detail := testRequest(router, "GET", "/api/canvas-projects/"+projectID, nil, ownerCookie)
	if detail.Code != 200 || object(responseRow(t, detail)["project"])["revision"] != float64(2) {
		t.Fatalf("画布详情应包含最新版本: %d %s", detail.Code, detail.Body.String())
	}
	list := testRequest(router, "GET", "/api/canvas-projects", nil, ownerCookie)
	if list.Code != 200 {
		t.Fatalf("画布列表失败: %d %s", list.Code, list.Body.String())
	}
	projects := responseRow(t, list)["projects"].([]any)
	if len(projects) == 0 || object(projects[0])["revision"] != float64(2) {
		t.Fatalf("画布列表应包含最新版本: %v", projects)
	}
	history, err := one(ctx, a.DB, "SELECT id FROM canvas_project_history WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1", projectID)
	if err != nil {
		t.Fatal(err)
	}
	restored := testRequest(router, "POST", "/api/canvas-projects/"+projectID+"/history/"+str(history["id"])+"/restore", nil, ownerCookie)
	if restored.Code != 200 || object(responseRow(t, restored)["project"])["revision"] != float64(3) {
		t.Fatalf("恢复历史应推进版本: %d %s", restored.Code, restored.Body.String())
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

// 视口保存不经过媒体引用同步，多带字段会变成分享媒体的授权依据，必须白名单拒绝。
func TestCanvasViewportRejectsExtraFields(t *testing.T) {
	a := testApp(t)
	_, cookie := testUser(t, a, 0)
	router := a.Router()
	created := testRequest(router, "POST", "/api/canvas-projects", map[string]any{"title": "视口画布", "snapshot": canvasTestSnapshot("")}, cookie)
	if created.Code != 200 {
		t.Fatalf("创建画布失败: %d %s", created.Code, created.Body.String())
	}
	projectID := str(object(responseRow(t, created)["project"])["id"])
	rejected := testRequest(router, "PUT", "/api/canvas-projects/"+projectID, map[string]any{
		"viewport": map[string]any{"x": 1.0, "y": 2.0, "k": 1.0, "mediaId": uuid.NewString()}, "expectedRevision": 0,
	}, cookie)
	if rejected.Code != 400 {
		t.Fatalf("视口夹带字段应拒绝: %d %s", rejected.Code, rejected.Body.String())
	}
	accepted := testRequest(router, "PUT", "/api/canvas-projects/"+projectID, map[string]any{
		"viewport": map[string]any{"x": 1.0, "y": 2.0, "k": 1.0}, "expectedRevision": 0,
	}, cookie)
	if accepted.Code != 200 {
		t.Fatalf("合法视口应保存: %d %s", accepted.Code, accepted.Body.String())
	}
}
