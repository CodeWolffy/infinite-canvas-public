package platform

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"

	"github.com/google/uuid"
)

func TestCanvasInvitationRequiresAcceptanceAndOwnerManagement(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	owner, ownerCookie := testUser(t, a, 0)
	member, memberCookie := testUser(t, a, 0)
	_, otherCookie := testUser(t, a, 0)
	project := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO canvas_projects(id,user_id,title,snapshot) VALUES($1,$2,'邀请画布','{\"nodes\":[],\"connections\":[]}'::jsonb)", project, owner); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	path := "/api/canvas-projects/" + project
	call := func(method, suffix string, input any, cookie *http.Cookie, status int) Row {
		t.Helper()
		response := testRequest(router, method, path+suffix, input, cookie)
		if response.Code != status {
			t.Fatalf("%s %s: %d %s", method, suffix, response.Code, response.Body.String())
		}
		if status == http.StatusNoContent {
			return nil
		}
		return responseRow(t, response)
	}
	initial := call("GET", "/collaboration", nil, ownerCookie, 200)
	if initial["share"] != nil || initial["canManage"] != true || object(initial["owner"])["userId"] != owner {
		t.Fatalf("new canvas must be member-only: %v", initial)
	}
	call("POST", "/members", Row{"username": member}, otherCookie, 404)
	invited := object(call("POST", "/members", Row{"username": member}, ownerCookie, 200)["member"])
	if invited["role"] != "viewer" || invited["status"] != "pending" {
		t.Fatalf("default invitation: %v", invited)
	}
	call("GET", "", nil, memberCookie, 404)
	call("POST", "/invitation", Row{"accept": true}, otherCookie, 404)
	response := testRequest(router, "GET", "/api/canvas-invitations", nil, memberCookie)
	if response.Code != 200 {
		t.Fatalf("invitation inbox: %d %s", response.Code, response.Body.String())
	}
	invitations := responseRow(t, response)["invitations"].([]any)
	if len(invitations) != 1 || object(invitations[0])["projectId"] != project || object(object(invitations[0])["invitedBy"])["userId"] != owner {
		t.Fatalf("invitation inbox: %v", invitations)
	}
	call("POST", "/invitation", Row{"accept": true}, memberCookie, 204)
	loaded := object(call("GET", "", nil, memberCookie, 200)["project"])
	if loaded["accessRole"] != "viewer" {
		t.Fatalf("accepted invitation role: %v", loaded)
	}
	listed := testRequest(router, "GET", "/api/canvas-projects", nil, memberCookie)
	if listed.Code != 200 || integer(responseRow(t, listed)["total"]) != 1 {
		t.Fatalf("accepted canvas missing from project list: %d %s", listed.Code, listed.Body.String())
	}
	if err := projectWriteAccess(ctx, a.DB, project, member); !errors.Is(err, notFound) {
		t.Fatalf("viewer write access: %v", err)
	}
	call("PATCH", "/members/"+member, Row{"role": "editor"}, memberCookie, 404)
	call("PATCH", "/members/"+owner, Row{"role": "viewer"}, ownerCookie, 403)
	call("PATCH", "/members/"+member, Row{"role": "editor"}, ownerCookie, 200)
	if err := projectWriteAccess(ctx, a.DB, project, member); err != nil {
		t.Fatalf("editor write access: %v", err)
	}
	call("GET", "/access-log", nil, memberCookie, 404)
	call("DELETE", "/members/"+member, nil, ownerCookie, 204)
	call("GET", "", nil, memberCookie, 404)
	call("POST", "/members", Row{"username": member}, ownerCookie, 200)
	call("POST", "/invitation", Row{"accept": false}, memberCookie, 204)
	if err := projectAccess(ctx, a.DB, project, member); !errors.Is(err, notFound) {
		t.Fatalf("rejected invitation granted access: %v", err)
	}
	log := call("GET", "/access-log?limit=1", nil, ownerCookie, 200)
	if integer(log["total"]) < 6 || len(log["items"].([]any)) != 1 {
		t.Fatalf("audit log pagination: %v", log)
	}
}

func TestCanvasDirectAndWorkspaceRolesUseHighestGrant(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	owner, ownerCookie := testUser(t, a, 0)
	member, _ := testUser(t, a, 0)
	workspace, project := uuid.NewString(), uuid.NewString()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{"INSERT INTO workspaces(id,name,owner_id) VALUES($1,'团队',$2)", []any{workspace, member}},
		{"INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", []any{workspace, member}},
		{"INSERT INTO canvas_projects(id,user_id,title,snapshot,workspace_id) VALUES($1,$2,'画布','{}',$3)", []any{project, owner, workspace}},
		{"INSERT INTO canvas_members(project_id,user_id,role,status,invited_by) VALUES($1,$2,'viewer','accepted',$3)", []any{project, member, owner}},
	} {
		if _, err := a.DB.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	check := func(want string) {
		t.Helper()
		role, err := projectRole(ctx, a.DB, project, member)
		if err != nil || role != want {
			t.Fatalf("role=%s want=%s err=%v", role, want, err)
		}
	}
	check("editor") // 工作区 owner 不能冒充资源所有者。
	response := testRequest(a.Router(), "GET", "/api/canvas-projects/"+project+"/collaboration", nil, ownerCookie)
	if response.Code != 200 {
		t.Fatalf("collaboration: %d %s", response.Code, response.Body.String())
	}
	sources := map[string]bool{}
	for _, row := range responseRow(t, response)["members"].([]any) {
		entry := object(row)
		if entry["userId"] == member {
			sources[str(entry["source"])] = true
		}
	}
	if !sources["workspace"] || !sources["direct"] {
		t.Fatalf("membership sources lost: %v", sources)
	}
	if _, err := a.DB.Exec(ctx, "UPDATE workspace_members SET role='viewer' WHERE workspace_id=$1 AND user_id=$2", workspace, member); err != nil {
		t.Fatal(err)
	}
	check("viewer")
	if _, err := a.DB.Exec(ctx, "UPDATE canvas_members SET role='editor' WHERE project_id=$1 AND user_id=$2", project, member); err != nil {
		t.Fatal(err)
	}
	check("editor")
	if _, err := a.DB.Exec(ctx, "DELETE FROM canvas_members WHERE project_id=$1 AND user_id=$2", project, member); err != nil {
		t.Fatal(err)
	}
	check("viewer")
	if _, err := a.DB.Exec(ctx, "DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", workspace, member); err != nil {
		t.Fatal(err)
	}
	check("")
}

func TestCanvasMemberMediaRevocationAndPersonalIsolation(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	owner, _ := testUser(t, a, 0)
	member, _ := testUser(t, a, 0)
	uploader, _ := testUser(t, a, 0)
	project, shared, personal, state := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, media := range []string{shared, personal} {
		if _, err := a.DB.Exec(ctx, "INSERT INTO media_objects(id,owner_id,object_key,original_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,'file.png','image/png',1,'hash')", media, uploader, uuid.NewString()); err != nil {
			t.Fatal(err)
		}
	}
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{"INSERT INTO canvas_projects(id,user_id,title,snapshot) VALUES($1,$2,'画布','{}')", []any{project, owner}},
		{"INSERT INTO canvas_members(project_id,user_id,status,invited_by) VALUES($1,$2,'pending',$3)", []any{project, member, owner}},
		{"INSERT INTO canvas_user_views(id,project_id,user_id) VALUES($1,$2,$3)", []any{state, project, member}},
		{"INSERT INTO media_references(owner_kind,owner_id,user_id,media_id) VALUES('canvas',$1,$3,$4),('canvas_personal',$2,$3,$5)", []any{project, state, member, shared, personal}},
	} {
		if _, err := a.DB.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	check := func(media, user string, allowed bool) {
		t.Helper()
		_, err := readableMedia(ctx, a.DB, media, user, false)
		if (err == nil) != allowed {
			t.Fatalf("media=%s user=%s allowed=%t err=%v", media, user, allowed, err)
		}
	}
	check(shared, member, false)
	check(personal, member, false)
	if _, err := a.DB.Exec(ctx, "UPDATE canvas_members SET status='accepted' WHERE project_id=$1 AND user_id=$2", project, member); err != nil {
		t.Fatal(err)
	}
	check(shared, member, true)
	check(personal, member, true)
	check(personal, owner, false)
	check(shared, owner, true)
	if _, err := a.DB.Exec(ctx, "DELETE FROM canvas_members WHERE project_id=$1 AND user_id=$2", project, member); err != nil {
		t.Fatal(err)
	}
	check(shared, member, false)
	check(personal, member, false)
}

func TestShareConcurrentCreateAndResetRevokePreviousToken(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	owner, _ := testUser(t, a, 0)
	project := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO canvas_projects(id,user_id,title,snapshot) VALUES($1,$2,'分享画布','{}')", project, owner); err != nil {
		t.Fatal(err)
	}
	type result struct {
		share Row
		err   error
	}
	results := make(chan result, 2)
	var workers sync.WaitGroup
	for range 2 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			share, err := a.createShare(ctx, "canvas", project, owner, false)
			results <- result{share, err}
		}()
	}
	workers.Wait()
	close(results)
	token := ""
	for item := range results {
		if item.err != nil {
			t.Fatal(item.err)
		}
		if token != "" && token != str(item.share["token"]) {
			t.Fatal("concurrent creation returned different active tokens")
		}
		token = str(item.share["token"])
		if object(item.share["createdBy"])["userId"] != owner {
			t.Fatalf("missing share creator: %v", item.share)
		}
	}
	reset, err := a.createShare(ctx, "canvas", project, owner, true)
	if err != nil || str(reset["token"]) == token {
		t.Fatalf("reset: %v %v", reset, err)
	}
	if _, err = a.activeShare(ctx, token); err == nil {
		t.Fatal("old share remains active after reset")
	}
	if _, err = a.activeShare(ctx, str(reset["token"])); err != nil {
		t.Fatal(err)
	}
	var created, resetCount, active int
	if err = a.DB.QueryRow(ctx, "SELECT count(*) FILTER(WHERE action='share_created'),count(*) FILTER(WHERE action='share_reset') FROM canvas_access_logs WHERE project_id=$1", project).Scan(&created, &resetCount); err != nil || created != 1 || resetCount != 1 {
		t.Fatalf("creation audit: %d %d %v", created, resetCount, err)
	}
	if err = a.DB.QueryRow(ctx, "SELECT count(*) FROM share_links WHERE kind='canvas' AND target_id=$1 AND revoked_at IS NULL", project).Scan(&active); err != nil || active != 1 {
		t.Fatalf("active shares: %d %v", active, err)
	}
}
