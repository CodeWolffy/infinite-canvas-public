package platform

import (
	"context"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/google/uuid"
)

func TestAssetRevisionRejectsConcurrentEditors(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	owner, ownerCookie := testUser(t, a, 0)
	editor, editorCookie := testUser(t, a, 0)
	workspace, id := uuid.NewString(), uuid.NewString()
	for _, statement := range []struct { query string; args []any }{
		{"INSERT INTO workspaces(id,owner_id,name) VALUES($1,$2,'素材协作')", []any{workspace, owner}},
		{"INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'editor')", []any{workspace, editor}},
		{"INSERT INTO assets(id,owner_id,workspace_id,type,title,content) VALUES($1,$2,$3,'text','共享素材','原文')", []any{id, owner, workspace}},
	} {
		if _, err := a.DB.Exec(ctx, statement.query, statement.args...); err != nil { t.Fatal(err) }
	}
	router := a.Router()
	responses := make(chan *httptest.ResponseRecorder, 2)
	go func() { responses <- testRequest(router, "PUT", "/api/assets/"+id, Row{"title": "所有者修订", "content": "owner", "expectedRevision": 0}, ownerCookie) }()
	go func() { responses <- testRequest(router, "PUT", "/api/assets/"+id, Row{"title": "编辑者修订", "content": "editor", "expectedRevision": 0}, editorCookie) }()
	success, conflict := 0, 0
	for range 2 {
		response := <-responses
		switch response.Code {
		case 200:
			success++
			if object(responseRow(t, response)["asset"])["revision"] != float64(1) { t.Fatal("成功更新未推进素材版本") }
		case 409:
			conflict++
			if responseRow(t, response)["error"] != "asset_conflict" { t.Fatal(response.Body.String()) }
		default: t.Fatalf("unexpected response: %d %s", response.Code, response.Body.String())
		}
	}
	if success != 1 || conflict != 1 { t.Fatalf("并发编辑应一项成功一项冲突: %d/%d", success, conflict) }
	missing := testRequest(router, "PUT", "/api/assets/"+id, Row{"title": "未携带版本"}, ownerCookie)
	if missing.Code != 409 { t.Fatalf("无版本不得覆盖: %d %s", missing.Code, missing.Body.String()) }
	latest := testRequest(router, "GET", "/api/assets/"+id, nil, editorCookie)
	if latest.Code != 200 || object(responseRow(t, latest)["asset"])["revision"] != float64(1) { t.Fatal(latest.Body.String()) }
	move := testRequest(router, "PUT", "/api/assets/"+id, Row{"workspaceId": ""}, ownerCookie)
	if move.Code != 200 || object(responseRow(t, move)["asset"])["revision"] != float64(2) { t.Fatalf("仅移动也应推进版本: %d %s", move.Code, move.Body.String()) }
}

func TestAssetImportRequestIsIdempotent(t *testing.T) {
	a := testApp(t)
	_, cookie := testUser(t, a, 0)
	_, otherCookie := testUser(t, a, 0)
	router := a.Router()
	input := Row{"type": "text", "title": "导入素材", "content": "同一条目", "requestId": "package-item-request"}
	responses := make(chan *httptest.ResponseRecorder, 2)
	for range 2 { go func() { responses <- testRequest(router, "POST", "/api/assets", input, cookie) }() }
	id := ""
	for range 2 {
		response := <-responses
		if response.Code != 200 { t.Fatalf("幂等创建失败: %d %s", response.Code, response.Body.String()) }
		created := str(object(responseRow(t, response)["asset"])["id"])
		if id != "" && created != id { t.Fatal("同一请求重复创建素材") }
		id = created
	}
	var count int
	if err := a.DB.QueryRow(context.Background(), "SELECT count(*) FROM assets WHERE client_request_id=$1", input["requestId"]).Scan(&count); err != nil || count != 1 { t.Fatalf("重复创建: %d %v", count, err) }
	different := testRequest(router, "POST", "/api/assets", Row{"type": "text", "title": "不同内容", "content": "改变", "requestId": input["requestId"]}, cookie)
	if different.Code != 409 || responseRow(t, different)["error"] != "idempotency_conflict" { t.Fatal(different.Body.String()) }
	other := testRequest(router, "POST", "/api/assets", input, otherCookie)
	if other.Code != 200 || str(object(responseRow(t, other)["asset"])["id"]) == id { t.Fatalf("请求编号必须按账号隔离: %d %s", other.Code, other.Body.String()) }
}

func TestAssetWorkspaceNullMovesToPersonalAndRejectsCollaborator(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	owner, ownerCookie := testUser(t, a, 0)
	editor, editorCookie := testUser(t, a, 0)
	workspace, id := uuid.NewString(), uuid.NewString()
	for _, statement := range []struct { query string; args []any }{
		{"INSERT INTO workspaces(id,owner_id,name) VALUES($1,$2,'素材移动')", []any{workspace, owner}},
		{"INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'editor')", []any{workspace, owner, editor}},
		{"INSERT INTO assets(id,owner_id,type,title,content) VALUES($1,$2,'text','移动素材','原文')", []any{id, owner}},
	} {
		if _, err := a.DB.Exec(ctx, statement.query, statement.args...); err != nil { t.Fatal(err) }
	}
	router := a.Router()
	moveIn := testRequest(router, "PUT", "/api/assets/"+id, Row{"workspaceId": workspace}, ownerCookie)
	if moveIn.Code != 200 || object(responseRow(t, moveIn)["asset"])["workspaceId"] != workspace || object(responseRow(t, moveIn)["asset"])["revision"] != float64(1) { t.Fatalf("移入失败: %d %s", moveIn.Code, moveIn.Body.String()) }
	for _, target := range []any{nil, ""} {
		denied := testRequest(router, "PUT", "/api/assets/"+id, Row{"workspaceId": target}, editorCookie)
		if denied.Code != 403 { t.Fatalf("协作者不得移出素材: %d %s", denied.Code, denied.Body.String()) }
	}
	edit := testRequest(router, "PUT", "/api/assets/"+id, Row{"title": "省略工作区的正常编辑", "expectedRevision": 1}, editorCookie)
	if edit.Code != 200 || object(responseRow(t, edit)["asset"])["workspaceId"] != workspace { t.Fatalf("省略字段不得移出素材: %d %s", edit.Code, edit.Body.String()) }
	moveOut := testRequest(router, "PUT", "/api/assets/"+id, Row{"workspaceId": nil}, ownerCookie)
	if moveOut.Code != 200 || object(responseRow(t, moveOut)["asset"])["workspaceId"] != nil || object(responseRow(t, moveOut)["asset"])["revision"] != float64(3) { t.Fatalf("null应移回个人并推进版本: %d %s", moveOut.Code, moveOut.Body.String()) }
	stale := testRequest(router, "PUT", "/api/assets/"+id, Row{"title": "旧编辑", "expectedRevision": 2}, ownerCookie)
	if stale.Code != 409 || responseRow(t, stale)["error"] != "asset_conflict" { t.Fatalf("移动后旧编辑必须冲突: %d %s", stale.Code, stale.Body.String()) }
	invalid := testRequest(router, "PUT", "/api/assets/"+id, Row{"workspaceId": 123}, ownerCookie)
	if invalid.Code != 400 { t.Fatalf("工作区必须是字符串或null: %d %s", invalid.Code, invalid.Body.String()) }
}

func TestAssetRevisionMigrationPreservesExistingAssets(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	owner, _ := testUser(t, a, 0)
	if _, err := a.DB.Exec(ctx, "ALTER TABLE assets DROP COLUMN revision, DROP COLUMN client_request_id, DROP COLUMN client_request_hash"); err != nil { t.Fatal(err) }
	id := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO assets(id,owner_id,type,title,content,metadata) VALUES($1,$2,'text','已有素材','保留正文','{\"tags\":[\"已有标签\"]}')", id, owner); err != nil { t.Fatal(err) }
	script, err := os.ReadFile("../../migrations/029_asset_revision.sql")
	if err != nil { t.Fatal(err) }
	if _, err = a.DB.Exec(ctx, string(script)); err != nil { t.Fatal(err) }
	record, err := one(ctx, a.DB, "SELECT * FROM assets WHERE id=$1", id)
	if err != nil || integer(record["revision"]) != 0 || record["title"] != "已有素材" || record["content"] != "保留正文" || len(object(record["metadata"])["tags"].([]any)) != 1 { t.Fatalf("迁移未保留已有素材: %v %v", record, err) }
	var nullable string
	if err = a.DB.QueryRow(ctx, "SELECT is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='assets' AND column_name='revision'").Scan(&nullable); err != nil || nullable != "NO" { t.Fatalf("版本应填充后收紧非空: %s %v", nullable, err) }
}

func TestAssetListFiltersPublicOwnersAndTagsWithoutWideningAccess(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	admin, adminCookie := testUser(t, a, 0)
	owner, _ := testUser(t, a, 0)
	other, otherCookie := testUser(t, a, 0)
	if _, err := a.DB.Exec(ctx, "UPDATE users SET role='admin' WHERE id=$1", admin); err != nil { t.Fatal(err) }
	if _, err := a.DB.Exec(ctx, "UPDATE users SET display_name='靠后用户' WHERE id=$1", owner); err != nil { t.Fatal(err) }
	for _, input := range []struct { owner, scope, title string }{{owner, "public", "公开条目"}, {owner, "private", "私人条目"}, {other, "public", "其他创建者"}} {
		if _, err := a.DB.Exec(ctx, "INSERT INTO assets(owner_id,scope,type,title,content,metadata) VALUES($1,$2,'text',$3,'正文','{\"tags\":[\"专属标签\"]}')", input.owner, input.scope, input.title); err != nil { t.Fatal(err) }
	}
	router := a.Router()
	query := "/api/assets?scope=public&ownerId="+owner+"&keyword=专属标签&limit=1"
	response := testRequest(router, "GET", query, nil, adminCookie)
	if response.Code != 200 { t.Fatal(response.Body.String()) }
	body := responseRow(t, response)
	items := body["assets"].([]any)
	if body["total"] != float64(1) || len(items) != 1 || object(items[0])["ownerName"] != "靠后用户" || object(items[0])["title"] != "公开条目" { t.Fatalf("公开列表筛选错误: %v", body) }
	next := testRequest(router, "GET", query+"&offset=1", nil, adminCookie)
	if next.Code != 200 || len(responseRow(t, next)["assets"].([]any)) != 0 || responseRow(t, next)["total"] != float64(1) { t.Fatal(next.Body.String()) }
	ordinary := testRequest(router, "GET", query+"&limit=100", nil, otherCookie)
	if ordinary.Code != 200 { t.Fatal(ordinary.Body.String()) }
	for _, item := range responseRow(t, ordinary)["assets"].([]any) { if object(item)["scope"] != "public" { t.Fatal("创建者筛选扩大了可见范围") } }
}
