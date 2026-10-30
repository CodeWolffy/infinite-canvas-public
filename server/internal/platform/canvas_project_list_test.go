package platform

import (
	"context"
	"net/http"
	"net/url"
	"testing"

	"github.com/google/uuid"
)

func canvasLibraryPage(t *testing.T, router http.Handler, path, field string, cookie *http.Cookie) ([]any, int64) {
	t.Helper()
	response := testRequest(router, "GET", path, nil, cookie)
	if response.Code != http.StatusOK {
		t.Fatalf("列表请求失败: %d %s", response.Code, response.Body.String())
	}
	row := responseRow(t, response)
	items, ok := row[field].([]any)
	if !ok {
		t.Fatalf("列表格式不正确: %v", row)
	}
	return items, integer(row["total"])
}

func TestCanvasProjectLibraryFiltersBeforePagination(t *testing.T) {
	a := testApp(t)
	owner, cookie := testUser(t, a, 0)
	viewer, viewerCookie := testUser(t, a, 0)
	other, _ := testUser(t, a, 0)
	ctx := context.Background()
	workspace, hiddenWorkspace := uuid.NewString(), uuid.NewString()
	for _, seed := range []struct { query string; args []any }{
		{"INSERT INTO workspaces(id,name,owner_id) VALUES($1,'共享工作区',$3),($2,'其他工作区',$4)", []any{workspace, hiddenWorkspace, owner, other}},
		{"INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer'),($4,$5,'owner')", []any{workspace, owner, viewer, hiddenWorkspace, other}},
		{"INSERT INTO canvas_projects(user_id,title,snapshot,created_at,updated_at) SELECT $1,'bulk-'||lpad(i::text,3,'0'),$2,now()-(i*interval '1 hour'),now()-(i*interval '1 minute') FROM generate_series(1,205) AS g(i)", []any{owner, jsonBytes(canvasTestSnapshot(""))}},
		{"INSERT INTO canvas_projects(user_id,title,snapshot,created_at,updated_at) VALUES($1,'商品目标',$2,now()-interval '500 hours',now()-interval '500 minutes')", []any{owner, jsonBytes(canvasTestSnapshot(""))}},
		{"INSERT INTO canvas_projects(user_id,title,snapshot,workspace_id) VALUES($1,'商品共享',$3,$4),($2,'商品隐藏',$3,$5)", []any{owner, other, jsonBytes(canvasTestSnapshot("")), workspace, hiddenWorkspace}},
	} {
		if _, err := a.DB.Exec(ctx, seed.query, seed.args...); err != nil {
			t.Fatal(err)
		}
	}
	router := a.Router()
	first, total := canvasLibraryPage(t, router, "/api/canvas-projects", "projects", cookie)
	if len(first) != 200 || total != 207 {
		t.Fatalf("应沿用默认200条分页: %d/%d", len(first), total)
	}
	for _, item := range first {
		project := object(item)
		if str(project["title"]) == "商品目标" || project["snapshot"] != nil {
			t.Fatalf("首批不应包含后续目标或完整快照: %v", project)
		}
	}
	second, total := canvasLibraryPage(t, router, "/api/canvas-projects?offset=200", "projects", cookie)
	if len(second) != 7 || total != 207 {
		t.Fatalf("第二页未完整加载: %d/%d", len(second), total)
	}
	keyword := url.QueryEscape("商品")
	items, total := canvasLibraryPage(t, router, "/api/canvas-projects?keyword="+keyword, "projects", cookie)
	if len(items) != 2 || total != 2 {
		t.Fatalf("搜索应包含首批之外的目标并排除其他用户画布: %v/%d", items, total)
	}
	items, total = canvasLibraryPage(t, router, "/api/canvas-projects?keyword="+keyword+"&workspaceId=personal", "projects", cookie)
	if total != 1 || str(object(items[0])["title"]) != "商品目标" {
		t.Fatalf("个人范围未在分页前筛选: %v/%d", items, total)
	}
	items, total = canvasLibraryPage(t, router, "/api/canvas-projects?workspaceId="+workspace, "projects", viewerCookie)
	if total != 1 || str(object(items[0])["accessRole"]) != "viewer" || object(items[0])["canDelete"] != false {
		t.Fatalf("工作区只读角色与删除权限丢失: %v/%d", items, total)
	}
	items, total = canvasLibraryPage(t, router, "/api/canvas-projects?workspaceId="+hiddenWorkspace, "projects", cookie)
	if len(items) != 0 || total != 0 {
		t.Fatalf("工作区筛选绕过了可见范围: %v/%d", items, total)
	}
	items, total = canvasLibraryPage(t, router, "/api/canvas-projects?keyword=bulk&sort=created_asc", "projects", cookie)
	if total != 205 || str(object(items[0])["title"]) != "bulk-205" {
		t.Fatalf("排序未覆盖全部分页: %v/%d", items[0], total)
	}
	items, total = canvasLibraryPage(t, router, "/api/canvas-projects?keyword=%25", "projects", cookie)
	if len(items) != 0 || total != 0 {
		t.Fatal("关键词中的百分号不应被当成通配符")
	}
}

func TestCanvasProjectCoverUsesAuthorizedPrimaryImage(t *testing.T) {
	a := testApp(t)
	owner, cookie := testUser(t, a, 0)
	viewer, viewerCookie := testUser(t, a, 0)
	other, _ := testUser(t, a, 0)
	ctx := context.Background()
	workspace := uuid.NewString()
	primary, secondary, private := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, seed := range []struct { query string; args []any }{
		{"INSERT INTO workspaces(id,name,owner_id) VALUES($1,'封面工作区',$2)", []any{workspace, owner}},
		{"INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer')", []any{workspace, owner, viewer}},
		{"INSERT INTO media_objects(id,owner_id,object_key,original_name,mime_type,byte_size,sha256) VALUES($1,$4,$1::uuid::text,'primary.png','image/png',1,'hash'),($2,$4,$2::uuid::text,'secondary.png','image/png',1,'hash'),($3,$5,$3::uuid::text,'private.png','image/png',1,'hash')", []any{primary, secondary, private, owner, other}},
	} {
		if _, err := a.DB.Exec(ctx, seed.query, seed.args...); err != nil {
			t.Fatal(err)
		}
	}
	metadata := map[string]any{
		"storageKey": "image:"+secondary, "primaryImageId": "primary",
		"images": []any{
			map[string]any{"id": "secondary", "storageKey": "image:"+secondary},
			map[string]any{"id": "primary", "content": "/api/media/"+primary},
		},
	}
	snapshot := canvasTestSnapshot("")
	object(snapshot["nodes"].([]any)[0])["metadata"] = metadata
	// 本用例验证列表及媒体权限；创建/保存HTTP入口另依赖Redis频控，
	// 这里在独立数据库构造与正常保存一致的快照和授权引用，不要求MinIO对象。
	projectID := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO canvas_projects(id,user_id,title,snapshot,workspace_id) VALUES($1,$2,'主图封面',$3,$4)", projectID, owner, jsonBytes(snapshot), workspace); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO media_references(owner_kind,owner_id,user_id,media_id) VALUES('canvas',$1,$2,$3),('canvas',$1,$2,$4)", projectID, owner, primary, secondary); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	items, total := canvasLibraryPage(t, router, "/api/canvas-projects?workspaceId="+workspace, "projects", viewerCookie)
	if total != 1 || str(object(items[0])["coverUrl"]) != "/api/media/"+primary || object(items[0])["canDelete"] != false {
		t.Fatalf("封面应使用当前主图并保留工作区只读权限: %v", items)
	}
	metadata["primaryImageId"] = "secondary"
	if _, err := a.DB.Exec(ctx, "UPDATE canvas_projects SET snapshot=$2,revision=revision+1,updated_at=now() WHERE id=$1", projectID, jsonBytes(snapshot)); err != nil {
		t.Fatalf("切换主图快照失败: %v", err)
	}
	items, _ = canvasLibraryPage(t, router, "/api/canvas-projects?workspaceId="+workspace, "projects", cookie)
	if str(object(items[0])["coverUrl"]) != "/api/media/"+secondary {
		t.Fatalf("列表未跟随已保存的主图变化: %v", items)
	}
	// 模拟未登记媒体引用的快照：即使字符串里有媒体ID，也不能当封面读取。
	unauthorized := canvasTestSnapshot(private)
	object(unauthorized["nodes"].([]any)[0])["metadata"] = map[string]any{"content": "https://untrusted.example/api/media/"+private}
	if _, err := a.DB.Exec(ctx, "INSERT INTO canvas_projects(user_id,title,snapshot) VALUES($1,'未授权封面',$2)", owner, jsonBytes(unauthorized)); err != nil {
		t.Fatal(err)
	}
	items, _ = canvasLibraryPage(t, router, "/api/canvas-projects?keyword="+url.QueryEscape("未授权封面"), "projects", cookie)
	if len(items) != 1 || object(items[0])["coverUrl"] != nil || str(object(items[0])["previewType"]) != "image" {
		t.Fatalf("未授权地址不得成为封面: %v", items)
	}
	if _, err := a.DB.Exec(ctx, "DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", workspace, viewer); err != nil {
		t.Fatal(err)
	}
	items, total = canvasLibraryPage(t, router, "/api/canvas-projects?workspaceId="+workspace, "projects", viewerCookie)
	if len(items) != 0 || total != 0 {
		t.Fatal("离开工作区后仍能看到画布封面")
	}
	if response := testRequest(router, "GET", "/api/media/"+primary, nil, viewerCookie); response.Code != http.StatusNotFound {
		t.Fatalf("撤销成员权限后仍可读取封面: %d", response.Code)
	}
}

func TestCanvasTemplateLibrarySearchAcrossPages(t *testing.T) {
	a := testApp(t)
	user, cookie := testUser(t, a, 0)
	ctx := context.Background()
	if _, err := a.DB.Exec(ctx, "INSERT INTO canvas_templates(title,snapshot,created_at) SELECT '模板-'||i::text,$1,now()-(i*interval '1 minute') FROM generate_series(1,205) AS g(i)", jsonBytes(canvasTestSnapshot(""))); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO canvas_templates(title,description,snapshot,created_at) VALUES('角色设定模板','用于商品主图视觉提案',$1,now()-interval '500 minutes')", jsonBytes(canvasTestSnapshot(""))); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	items, total := canvasLibraryPage(t, router, "/api/canvas-templates", "templates", cookie)
	if len(items) != 200 || total != 206 {
		t.Fatalf("模板列表未沿用默认分页: %d/%d", len(items), total)
	}
	items, total = canvasLibraryPage(t, router, "/api/canvas-templates?keyword="+url.QueryEscape("商品"), "templates", cookie)
	if total != 1 || str(object(items[0])["title"]) != "角色设定模板" {
		t.Fatalf("关键词未覆盖首批之外模板的用途描述: %v/%d", items, total)
	}
	items, total = canvasLibraryPage(t, router, "/api/canvas-templates?offset=200", "templates", cookie)
	if len(items) != 6 || total != 206 {
		t.Fatalf("后续模板未完整加载: %d/%d", len(items), total)
	}
	if _, err := a.DB.Exec(ctx, "UPDATE users SET role='admin' WHERE id=$1", user); err != nil {
		t.Fatal(err)
	}
	items, total = canvasLibraryPage(t, router, "/api/admin/canvas-templates?keyword=does-not-exist", "templates", cookie)
	if len(items) != 200 || total != 206 {
		t.Fatal("管理员原有模板列表行为被改动")
	}
}
