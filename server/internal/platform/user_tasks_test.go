package platform

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func userTasksModel(t *testing.T, a *App, capability string) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := a.DB.Exec(context.Background(), "INSERT INTO models(id,name,display_name,capability) VALUES($1,'task-model','任务模型',$2)", id, capability); err != nil {
		t.Fatal(err)
	}
	return id
}

func userTasksBatch(t *testing.T, a *App, user, model, capability, project string) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := a.DB.Exec(context.Background(), "INSERT INTO generation_batches(id,user_id,model_id,capability,canvas_project_id,prompt,requested_count,request_key,request_hash) VALUES($1,$2,$3,$4,$5,'私有提示词',1,$6,'fixture')", id, user, model, capability, nullable(project), uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	return id
}

func userTasksTask(t *testing.T, a *App, user, model, capability, status, batch, conversation, media string) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := a.DB.Exec(context.Background(), `INSERT INTO generation_tasks(id,user_id,model_id,capability,status,batch_id,conversation_id,output_media_id,model_name,model_display_name,prompt,error_message,price_micros)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,'task-model','任务模型','私有提示词','私有错误信息',0)`, id, user, model, capability, status, nullable(batch), nullable(conversation), nullable(media)); err != nil {
		t.Fatal(err)
	}
	return id
}

func userTasksPage(t *testing.T, a *App, cookie *http.Cookie, query string) Row {
	t.Helper()
	response := testRequest(a.Router(), "GET", "/api/generation-tasks"+query, nil, cookie)
	if response.Code != http.StatusOK {
		t.Fatalf("tasks: %d %s", response.Code, response.Body.String())
	}
	return responseRow(t, response)
}

func userTasksByID(page Row) map[string]Row {
	tasks := map[string]Row{}
	for _, item := range page["tasks"].([]any) {
		task := object(item)
		tasks[str(task["id"])] = task
	}
	return tasks
}

func TestUserTasksOwnershipFiltersAndPagination(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 0)
	other, otherCookie := testUser(t, a, 0)
	models := map[string]string{}
	for _, capability := range []string{"image", "video", "audio", "text"} {
		models[capability] = userTasksModel(t, a, capability)
	}
	imageBatch := userTasksBatch(t, a, user, models["image"], "image", "")
	videoBatch := userTasksBatch(t, a, user, models["video"], "video", "")
	deletedBatch := userTasksBatch(t, a, user, models["image"], "image", "")
	conversation, media := uuid.NewString(), uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO conversations(id,user_id,title) VALUES($1,$2,'独立文本对话')", conversation, user); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO media_objects(id,owner_id,object_key,original_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,'result.mp3','audio/mpeg',1,'fixture')", media, user, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	userTasksTask(t, a, user, models["image"], "image", "reviewing", imageBatch, "", "")
	queued := userTasksTask(t, a, user, models["video"], "video", "queued", videoBatch, "", "")
	audio := userTasksTask(t, a, user, models["audio"], "audio", "succeeded", "", "", media)
	text := userTasksTask(t, a, user, models["text"], "text", "running", "", conversation, "")
	failed := userTasksTask(t, a, user, models["image"], "image", "failed", imageBatch, "", "")
	userTasksTask(t, a, user, models["image"], "image", "canceled", imageBatch, "", "")
	deleted := userTasksTask(t, a, user, models["image"], "image", "succeeded", deletedBatch, "", "")
	otherTask := userTasksTask(t, a, other, models["image"], "image", "failed", "", "", "")
	if _, err := a.DB.Exec(ctx, "UPDATE generation_batches SET deleted_at=now() WHERE id=$1", deletedBatch); err != nil {
		t.Fatal(err)
	}
	page := userTasksPage(t, a, cookie, "?userId="+other)
	tasks := userTasksByID(page)
	if integer(page["total"]) != 6 || len(tasks) != 6 || integer(page["limit"]) != 50 || integer(page["offset"]) != 0 || tasks[deleted] != nil || tasks[otherTask] != nil {
		t.Fatalf("ownership/deletion/default page: %v", page)
	}
	if tasks[text]["batchId"] != nil || tasks[text]["conversationId"] != conversation || tasks[audio]["batchId"] != nil || object(tasks[audio]["output"])["url"] != "/api/media/"+media {
		t.Fatalf("text and audio must not require a batch: %v", tasks)
	}
	if summary := object(page["summary"]); integer(summary["reviewing"]) != 1 || integer(summary["queued"]) != 1 || integer(summary["running"]) != 1 {
		t.Fatalf("active summary must include all own modalities: %v", summary)
	}
	for _, filter := range []struct {
		query string
		id    string
	}{
		{"?capability=image&status=failed", failed},
		{"?status=queued", queued},
		{"?capability=text", text},
	} {
		filtered := userTasksPage(t, a, cookie, filter.query)
		if integer(filtered["total"]) != 1 || len(userTasksByID(filtered)) != 1 || userTasksByID(filtered)[filter.id] == nil {
			t.Fatalf("list/count filters disagree for %s: %v", filter.query, filtered)
		}
		if summary := object(filtered["summary"]); filter.query == "?status=queued" && (integer(summary["reviewing"]) != 1 || integer(summary["queued"]) != 1 || integer(summary["running"]) != 1) {
			t.Fatalf("status filter must not hide other active states: %v", summary)
		} else if filter.query == "?capability=image&status=failed" && (integer(summary["reviewing"]) != 1 || integer(summary["queued"]) != 0 || integer(summary["running"]) != 0) {
			t.Fatalf("active summary must follow modality filter: %v", summary)
		}
	}
	paged := userTasksPage(t, a, cookie, "?limit=2&offset=1")
	if integer(paged["total"]) != 6 || len(userTasksByID(paged)) != 2 || integer(paged["offset"]) != 1 {
		t.Fatalf("pagination: %v", paged)
	}
	if summary := object(paged["summary"]); integer(summary["reviewing"]) != 1 || integer(summary["queued"]) != 1 || integer(summary["running"]) != 1 {
		t.Fatalf("active summary must not be limited to current page: %v", summary)
	}
	if empty := userTasksPage(t, a, cookie, "?limit=2&offset=99"); integer(empty["total"]) != 6 || len(userTasksByID(empty)) != 0 {
		t.Fatalf("empty page must preserve total: %v", empty)
	}
	if capped := userTasksPage(t, a, cookie, "?limit=999&offset=-1"); integer(capped["limit"]) != 200 || integer(capped["offset"]) != 0 {
		t.Fatalf("existing pagination bounds: %v", capped)
	}
	if own := userTasksPage(t, a, otherCookie, ""); integer(own["total"]) != 1 || userTasksByID(own)[otherTask] == nil {
		t.Fatalf("other account must receive only its own task: %v", own)
	}
	for _, query := range []string{"?capability=unknown", "?status=paused"} {
		if response := testRequest(a.Router(), "GET", "/api/generation-tasks"+query, nil, cookie); response.Code != http.StatusBadRequest {
			t.Fatalf("invalid filter: %d %s", response.Code, response.Body.String())
		}
	}
	if response := testRequest(a.Router(), "GET", "/api/generation-tasks", nil, nil); response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous tasks: %d %s", response.Code, response.Body.String())
	}
}

func TestUserTasksRedactRevokedAndForeignSources(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	owner, _ := testUser(t, a, 0)
	user, cookie := testUser(t, a, 0)
	workspace, project, conversation, standalone, foreignConversation, media, foreignMedia := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{"INSERT INTO workspaces(id,name,owner_id) VALUES($1,'团队',$2)", []any{workspace, owner}},
		{"INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer')", []any{workspace, owner, user}},
		{"INSERT INTO canvas_projects(id,user_id,title,snapshot,workspace_id) VALUES($1,$2,'私有画布','{}',$3)", []any{project, owner, workspace}},
		{"INSERT INTO conversations(id,user_id,title,canvas_project_id) VALUES($1,$2,'画布对话',$3),($4,$2,'独立对话',NULL),($5,$6,'他人对话',NULL)", []any{conversation, user, project, standalone, foreignConversation, owner}},
		{"INSERT INTO media_objects(id,owner_id,object_key,original_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,'own.png','image/png',1,'fixture'),($4,$5,$6,'foreign.png','image/png',1,'fixture')", []any{media, user, uuid.NewString(), foreignMedia, owner, uuid.NewString()}},
	} {
		if _, err := a.DB.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	imageModel, textModel, audioModel := userTasksModel(t, a, "image"), userTasksModel(t, a, "text"), userTasksModel(t, a, "audio")
	batch := userTasksBatch(t, a, user, imageModel, "image", project)
	foreignBatch := userTasksBatch(t, a, owner, imageModel, "image", "")
	image := userTasksTask(t, a, user, imageModel, "image", "succeeded", batch, "", media)
	text := userTasksTask(t, a, user, textModel, "text", "queued", "", conversation, "")
	deletedConversation := userTasksTask(t, a, user, textModel, "text", "failed", "", standalone, "")
	foreignText := userTasksTask(t, a, user, textModel, "text", "failed", "", foreignConversation, "")
	foreignOutput := userTasksTask(t, a, user, audioModel, "audio", "succeeded", "", "", foreignMedia)
	foreignBatchTask := userTasksTask(t, a, user, imageModel, "image", "failed", foreignBatch, "", "")
	before := userTasksByID(userTasksPage(t, a, cookie, ""))
	if before[image]["canvasProjectId"] != project || object(before[image]["output"])["mediaId"] != media || before[text]["canvasProjectId"] != project || before[text]["conversationId"] != conversation {
		t.Fatalf("current viewer can read its task's canvas source: %v", before)
	}
	if before[foreignOutput]["output"] != nil || before[foreignText]["sourceUnavailable"] != "conversation" || before[foreignText]["prompt"] != nil || before[foreignBatchTask] != nil {
		t.Fatalf("foreign relations or output leaked: %v", before)
	}
	if _, err := a.DB.Exec(ctx, "DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", workspace, user); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "UPDATE conversations SET deleted_at=now() WHERE id=$1", standalone); err != nil {
		t.Fatal(err)
	}
	page := userTasksPage(t, a, cookie, "")
	after := userTasksByID(page)
	if integer(page["total"]) != 5 || len(after) != 5 {
		t.Fatalf("redaction must retain own status in both list and count: %v", page)
	}
	for _, id := range []string{image, text, deletedConversation, foreignText} {
		task := after[id]
		if task == nil || task["status"] == nil || task["price"] == nil || task["sourceUnavailable"] == nil {
			t.Fatalf("task state lost after source became unavailable: %v", task)
		}
		for _, field := range []string{"prompt", "errorMessage", "batchId", "conversationId", "canvasProjectId", "sourceTitle", "output", "image"} {
			if task[field] != nil {
				t.Fatalf("unavailable source leaked %s: %v", field, task)
			}
		}
	}
	if after[image]["sourceUnavailable"] != "canvas" || after[text]["sourceUnavailable"] != "canvas" || after[deletedConversation]["sourceUnavailable"] != "conversation" {
		t.Fatalf("source failure reason: %v", after)
	}
}
