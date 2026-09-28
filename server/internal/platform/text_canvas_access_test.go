package platform

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func TestTextCanvasBindingRequiresWriteAccess(t *testing.T) {
	a := testApp(t)
	if a.Redis == nil {
		t.Skip("需要 TEST_REDIS_ADDR")
	}
	ctx := context.Background()
	settings := defaultSettings
	settings.UserRPM, settings.IPRPM = 0, 0
	if _, err := a.DB.Exec(ctx, "INSERT INTO app_settings(key,value) VALUES('platform',$1)", jsonBytes(settings)); err != nil {
		t.Fatal(err)
	}
	ownerID, ownerCookie := testUser(t, a, 0)
	editorID, editorCookie := testUser(t, a, 0)
	viewerID, viewerCookie := testUser(t, a, 0)
	workspaceID, projectID := uuid.NewString(), uuid.NewString()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{"INSERT INTO workspaces(id,name,owner_id) VALUES($1,'团队',$2)", []any{workspaceID, ownerID}},
		{"INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'editor'),($1,$4,'viewer')", []any{workspaceID, ownerID, editorID, viewerID}},
		{"INSERT INTO canvas_projects(id,user_id,title,snapshot,workspace_id) VALUES($1,$2,'画布','{}',$3)", []any{projectID, ownerID, workspaceID}},
	} {
		if _, err := a.DB.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	model, _ := capabilityModel(t, a, "text", "http://localhost", 0)
	router := a.Router()
	for _, role := range []struct {
		name   string
		cookie *http.Cookie
		want   int
	}{
		{"owner", ownerCookie, 200},
		{"editor", editorCookie, 200},
		{"viewer", viewerCookie, 404},
	} {
		t.Run(role.name, func(t *testing.T) {
			conversation := testRequest(router, "POST", "/api/text/conversations", Row{"canvasProjectId": projectID, "title": "画布对话"}, role.cookie)
			if conversation.Code != role.want {
				t.Fatalf("conversation: %d %s", conversation.Code, conversation.Body.String())
			}
			request := testRequest(router, "POST", "/api/text/requests", Row{"requestId": uuid.NewString(), "modelId": model, "content": "你好", "canvasProjectId": projectID}, role.cookie)
			if request.Code != role.want {
				t.Fatalf("request: %d %s", request.Code, request.Body.String())
			}
		})
	}
	formerEditorConversation := testRequest(router, "POST", "/api/text/conversations", Row{"canvasProjectId": projectID}, editorCookie)
	if formerEditorConversation.Code != 200 {
		t.Fatalf("editor conversation before demotion: %d %s", formerEditorConversation.Code, formerEditorConversation.Body.String())
	}
	if _, err := a.DB.Exec(ctx, "UPDATE workspace_members SET role='viewer' WHERE workspace_id=$1 AND user_id=$2", workspaceID, editorID); err != nil {
		t.Fatal(err)
	}
	conversationID := str(object(responseRow(t, formerEditorConversation)["conversation"])["id"])
	continued := testRequest(router, "POST", "/api/text/requests", Row{"requestId": uuid.NewString(), "modelId": model, "content": "继续", "conversationId": conversationID}, editorCookie)
	if continued.Code != 404 {
		t.Fatalf("demoted editor must not continue canvas conversation: %d %s", continued.Code, continued.Body.String())
	}
	conversation := testRequest(router, "POST", "/api/text/conversations", Row{"title": "独立对话"}, viewerCookie)
	if conversation.Code != 200 {
		t.Fatalf("standalone conversation: %d %s", conversation.Code, conversation.Body.String())
	}
	request := testRequest(router, "POST", "/api/text/requests", Row{"requestId": uuid.NewString(), "modelId": model, "content": "你好"}, viewerCookie)
	if request.Code != 200 {
		t.Fatalf("standalone request: %d %s", request.Code, request.Body.String())
	}
	var canvasConversations int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM conversations WHERE user_id=$1 AND canvas_project_id=$2", viewerID, projectID).Scan(&canvasConversations); err != nil || canvasConversations != 0 {
		t.Fatalf("viewer created canvas conversations: %d %v", canvasConversations, err)
	}
}
