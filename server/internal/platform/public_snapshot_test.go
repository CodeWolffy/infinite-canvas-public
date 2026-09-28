package platform

import (
	"context"
	"os"
	"reflect"
	"testing"

	"github.com/google/uuid"
)

func privateCanvasSnapshot(mediaID string) map[string]any {
	return map[string]any{
		"nodes":          []any{map[string]any{"id": "n1", "type": "image", "metadata": map[string]any{"storageKey": "image:" + mediaID}}},
		"connections":    []any{map[string]any{"id": "c1", "fromNodeId": "n1", "toNodeId": "n1"}},
		"viewport":       map[string]any{"x": 12.0, "y": 34.0, "k": 1.5},
		"backgroundMode": "dots",
		"showImageInfo":  true,
		"chatSessions":   []any{map[string]any{"id": "private-chat", "messages": []any{map[string]any{"content": "private assistant history"}}}},
		"activeChatId":   "private-chat",
	}
}

func assertPublicSnapshot(t *testing.T, snapshot map[string]any, source map[string]any) {
	t.Helper()
	for _, key := range []string{"chatSessions", "activeChatId"} {
		if _, exists := snapshot[key]; exists {
			t.Errorf("public snapshot exposed %s", key)
		}
	}
	for _, key := range []string{"nodes", "connections", "viewport", "backgroundMode", "showImageInfo"} {
		if !reflect.DeepEqual(snapshot[key], source[key]) {
			t.Errorf("public snapshot changed %s: got %v, want %v", key, snapshot[key], source[key])
		}
	}
}

func TestPublicCanvasSnapshotDoesNotMutateSource(t *testing.T) {
	source := privateCanvasSnapshot(uuid.NewString())
	public := publicCanvasSnapshot(source)
	assertPublicSnapshot(t, public, source)
	if _, ok := source["chatSessions"]; !ok {
		t.Fatal("source chat sessions were removed")
	}
	if source["activeChatId"] != "private-chat" {
		t.Fatal("source active chat was changed")
	}
}

func TestTemplateCreationStoresPublicSnapshot(t *testing.T) {
	a := testApp(t)
	userID, cookie, _ := testAdmin(t, a)
	ctx := context.Background()
	mediaID, projectID := uuid.NewString(), uuid.NewString()
	source := privateCanvasSnapshot(mediaID)
	if _, err := a.DB.Exec(ctx, "INSERT INTO media_objects(id,owner_id,object_key,original_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,'image.png','image/png',1,'hash')", mediaID, userID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO canvas_projects(id,user_id,title,snapshot) VALUES($1,$2,'私有画布',$3)", projectID, userID, jsonBytes(source)); err != nil {
		t.Fatal(err)
	}
	created := testRequest(a.Router(), "POST", "/api/admin/canvas-templates", map[string]any{"title": "公开模板", "projectId": projectID}, cookie)
	if created.Code != 200 {
		t.Fatalf("create template: %d %s", created.Code, created.Body.String())
	}
	templateID := str(object(responseRow(t, created)["template"])["id"])
	tpl, err := one(ctx, a.DB, "SELECT snapshot FROM canvas_templates WHERE id=$1", templateID)
	if err != nil {
		t.Fatal(err)
	}
	assertPublicSnapshot(t, object(tpl["snapshot"]), source)
	project, err := one(ctx, a.DB, "SELECT snapshot FROM canvas_projects WHERE id=$1", projectID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(object(project["snapshot"]), source) {
		t.Fatalf("source canvas changed: %v", project["snapshot"])
	}
	var refs int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM media_references WHERE owner_kind='template' AND owner_id=$1 AND media_id=$2", templateID, mediaID).Scan(&refs); err != nil || refs != 1 {
		t.Fatalf("template media reference: count=%d err=%v", refs, err)
	}
}

func TestPublicShareResponseOmitsAssistantHistory(t *testing.T) {
	if os.Getenv("TEST_REDIS_ADDR") == "" {
		t.Skip("public sharing requires TEST_REDIS_ADDR")
	}
	a := testApp(t)
	userID, _ := testUser(t, a, 0)
	ctx := context.Background()
	projectID, token := uuid.NewString(), "share-"+uuid.NewString()
	source := privateCanvasSnapshot(uuid.NewString())
	if _, err := a.DB.Exec(ctx, "INSERT INTO canvas_projects(id,user_id,title,snapshot) VALUES($1,$2,'私有画布',$3)", projectID, userID, jsonBytes(source)); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO share_links(user_id,kind,target_id,token) VALUES($1,'canvas',$2,$3)", userID, projectID, token); err != nil {
		t.Fatal(err)
	}
	response := testRequest(a.Router(), "GET", "/api/shared/"+token, nil, nil)
	if response.Code != 200 {
		t.Fatalf("read public share: %d %s", response.Code, response.Body.String())
	}
	body := responseRow(t, response)
	if body["kind"] != "canvas" {
		t.Fatalf("unexpected share kind: %v", body["kind"])
	}
	assertPublicSnapshot(t, object(object(body["canvas"])["snapshot"]), source)
	project, err := one(ctx, a.DB, "SELECT snapshot FROM canvas_projects WHERE id=$1", projectID)
	if err != nil || object(project["snapshot"])["activeChatId"] != "private-chat" {
		t.Fatalf("source canvas chat was changed: %v %v", project, err)
	}
}
