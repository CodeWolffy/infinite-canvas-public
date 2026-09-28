package platform

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestWorkspaceOwnerCannotBeDemotedByAddingMember(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	owner, cookie := testUser(t, a, 0)
	workspace := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO workspaces(id,name,owner_id) VALUES($1,'团队',$2)", workspace, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", workspace, owner); err != nil {
		t.Fatal(err)
	}
	for _, role := range []string{"viewer", "editor"} {
		response := testRequest(a.Router(), "POST", "/api/workspaces/"+workspace+"/members", Row{"username": owner, "role": role}, cookie)
		if response.Code != 403 || responseRow(t, response)["error"] != "owner_role_protected" {
			t.Fatalf("owner demotion to %s: %d %s", role, response.Code, response.Body.String())
		}
		var actual string
		if err := a.DB.QueryRow(ctx, "SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", workspace, owner).Scan(&actual); err != nil || actual != "owner" {
			t.Fatalf("owner role after %s: %s %v", role, actual, err)
		}
	}
}

func TestCanvasMediaAccessFollowsCurrentMembership(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	owner, _ := testUser(t, a, 0)
	uploader, _ := testUser(t, a, 0)
	member, cookie := testUser(t, a, 0)
	workspace, project, media := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{"INSERT INTO workspaces(id,name,owner_id) VALUES($1,'团队',$2)", []any{workspace, owner}},
		{"INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'editor')", []any{workspace, owner, member}},
		{"INSERT INTO canvas_projects(id,user_id,title,snapshot,workspace_id) VALUES($1,$2,'画布','{}',$3)", []any{project, owner, workspace}},
		{"INSERT INTO media_objects(id,owner_id,object_key,original_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,'file.png','image/png',1,'hash')", []any{media, uploader, uuid.NewString()}},
		{"INSERT INTO media_references(owner_kind,owner_id,user_id,media_id) VALUES('canvas',$1,$2,$3)", []any{project, member, media}},
	} {
		if _, err := a.DB.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	check := func(user string, allowed bool) {
		t.Helper()
		_, err := readableMedia(ctx, a.DB, media, user, false)
		if (err == nil) != allowed {
			t.Fatalf("media access user=%s allowed=%t: %v", user, allowed, err)
		}
	}
	check(owner, true) // 引用创建人并非画布所有者。
	check(member, true)
	check(uploader, true) // 本人上传的媒体始终可读。
	if _, err := a.DB.Exec(ctx, "DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", workspace, member); err != nil {
		t.Fatal(err)
	}
	check(member, false) // mr.user_id 仍是被移除的成员。
	if response := testRequest(a.Router(), "GET", "/api/media/"+media, nil, cookie); response.Code != 404 {
		t.Fatalf("removed member media HTTP: %d %s", response.Code, response.Body.String())
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'viewer')", workspace, member); err != nil {
		t.Fatal(err)
	}
	check(member, true)
	if _, err := a.DB.Exec(ctx, "DELETE FROM workspaces WHERE id=$1", workspace); err != nil {
		t.Fatal(err)
	}
	check(member, false) // 项目仍在，但工作区删除后已转为私有。
	check(owner, true)
}

func TestStaleAssetAndHistoryMediaReferencesDoNotGrantAccess(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	owner, _ := testUser(t, a, 0)
	other, _ := testUser(t, a, 0)
	uploader, _ := testUser(t, a, 0)
	media, project, history, asset := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{"INSERT INTO media_objects(id,owner_id,object_key,original_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,'file.png','image/png',1,'hash')", []any{media, uploader, uuid.NewString()}},
		{"INSERT INTO canvas_projects(id,user_id,title,snapshot) VALUES($1,$2,'画布','{}')", []any{project, owner}},
		{"INSERT INTO canvas_project_history(id,project_id,user_id,title,snapshot) VALUES($1,$2,$3,'历史','{}')", []any{history, project, other}},
		{"INSERT INTO assets(id,owner_id,type,title,media_id) VALUES($1,$2,'image','素材',$3)", []any{asset, owner, media}},
		{"INSERT INTO media_references(owner_kind,owner_id,user_id,media_id) VALUES('history',$1,$3,$4),('asset',$2,$3,$4)", []any{history, asset, other, media}},
	} {
		if _, err := a.DB.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := readableMedia(ctx, a.DB, media, other, false); err == nil {
		t.Fatal("stale history/asset references leaked media")
	}
	for _, user := range []string{owner, uploader} {
		if _, err := readableMedia(ctx, a.DB, media, user, false); err != nil {
			t.Fatalf("legitimate access for %s: %v", user, err)
		}
	}
}

func TestRetainedMediaReferencesFollowOwnerAfterSoftDelete(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	owner, _ := testUser(t, a, 0)
	uploader, _ := testUser(t, a, 0)
	other, _ := testUser(t, a, 0)
	model, _ := capabilityModel(t, a, "image", "http://localhost", 0)
	batch, task, conversation, message := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	batchMedia, taskMedia, messageMedia := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, id := range []string{batchMedia, taskMedia, messageMedia} {
		if _, err := a.DB.Exec(ctx, "INSERT INTO media_objects(id,owner_id,object_key,original_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,'file.png','image/png',1,'hash')", id, uploader, uuid.NewString()); err != nil {
			t.Fatal(err)
		}
	}
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{"INSERT INTO generation_batches(id,user_id,model_id,capability,prompt,requested_count,request_key,request_hash,deleted_at) VALUES($1,$2,$3,'image','test',1,$4,'hash',now())", []any{batch, owner, model, uuid.NewString()}},
		{"INSERT INTO generation_tasks(id,batch_id,user_id,model_id,capability,model_name,model_display_name,prompt,price_micros,status,output_media_id) VALUES($1,$2,$3,$4,'image','test','test','test',0,'succeeded',$5)", []any{task, batch, owner, model, taskMedia}},
		{"INSERT INTO conversations(id,user_id,title,deleted_at) VALUES($1,$2,'对话',now())", []any{conversation, owner}},
		{"INSERT INTO messages(id,conversation_id,role,content) VALUES($1,$2,'user','test')", []any{message, conversation}},
		{"INSERT INTO media_references(owner_kind,owner_id,user_id,media_id) VALUES('batch',$1,$4,$5),('task',$2,$4,$6),('message',$3,$4,$7)", []any{batch, task, message, other, batchMedia, taskMedia, messageMedia}},
	} {
		if _, err := a.DB.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	for _, media := range []string{batchMedia, taskMedia, messageMedia} {
		if _, err := readableMedia(ctx, a.DB, media, owner, false); err != nil {
			t.Fatalf("owner lost retained media %s: %v", media, err)
		}
		if _, err := readableMedia(ctx, a.DB, media, other, false); err == nil {
			t.Fatalf("stale reference user gained media %s", media)
		}
	}
}

func TestGenerationBatchRequiresCanvasWriteAccess(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	settings := defaultSettings
	settings.UserRPM, settings.IPRPM = 0, 0
	if _, err := a.DB.Exec(ctx, "INSERT INTO app_settings(key,value) VALUES('platform',$1)", jsonBytes(settings)); err != nil {
		t.Fatal(err)
	}
	owner, _ := testUser(t, a, 0)
	viewer, cookie := testUser(t, a, 0)
	workspace, project := uuid.NewString(), uuid.NewString()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{"INSERT INTO workspaces(id,name,owner_id) VALUES($1,'团队',$2)", []any{workspace, owner}},
		{"INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer')", []any{workspace, owner, viewer}},
		{"INSERT INTO canvas_projects(id,user_id,title,snapshot,workspace_id) VALUES($1,$2,'画布','{}',$3)", []any{project, owner, workspace}},
	} {
		if _, err := a.DB.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	model, _ := capabilityModel(t, a, "image", "http://localhost", 0)
	input := Row{"requestId": uuid.NewString(), "modelId": model, "prompt": "test", "count": 1, "canvasProjectId": project}
	response := testRequest(a.Router(), "POST", "/api/generation-batches", input, cookie)
	if response.Code != 404 {
		t.Fatalf("viewer generation should be denied: %d %s", response.Code, response.Body.String())
	}
	input["canvasProjectId"] = ""
	input["requestId"] = uuid.NewString()
	response = testRequest(a.Router(), "POST", "/api/generation-batches", input, cookie)
	if response.Code != 200 {
		t.Fatalf("generation without canvas should remain allowed: %d %s", response.Code, response.Body.String())
	}
}
