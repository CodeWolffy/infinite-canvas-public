package platform

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestResponsesImageInputUsageAndSettlement(t *testing.T) {
	a := testApp(t)
	if a.Redis == nil || a.S3 == nil {
		t.Skip("需要 TEST_REDIS_ADDR 与 TEST_MINIO_ADDR")
	}
	ctx := context.Background()
	user, cookie := testUser(t, a, moneyScale)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if !strings.HasSuffix(r.URL.Path, "/responses") {
			t.Errorf("unexpected endpoint %s", r.URL.Path)
		}
		var input struct {
			Input []responsesMessage `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
			return
		}
		if len(input.Input) != 2 || input.Input[0].Role != "system" || input.Input[1].Role != "user" {
			t.Errorf("input: %+v", input)
			return
		}
		var parts []responsesContent
		if err := json.Unmarshal(input.Input[1].Content, &parts); err != nil {
			t.Error(err)
			return
		}
		if len(parts) != 2 || parts[0].Type != "input_text" || parts[0].Text != "看图" || parts[1].Type != "input_image" || !strings.HasPrefix(parts[1].ImageURL, "data:image/png;base64,") {
			t.Errorf("invalid image content: %+v", parts)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"图片内容\"}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":100,\"input_tokens_details\":{\"cached_tokens\":80},\"output_tokens\":5}}}\n\n")
	}))
	defer upstream.Close()
	model, ch := capabilityModel(t, a, "text", upstream.URL, 0)
	if _, err := a.DB.Exec(ctx, "UPDATE channels SET endpoint_path='responses' WHERE id=$1", ch); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, `UPDATE models SET input_price_per_million=1000000,cached_price_per_million=250000,output_price_per_million=2000000,config=config||'{"imageInput":true,"maxOutputTokens":20}'::jsonb WHERE id=$1`, model); err != nil {
		t.Fatal(err)
	}
	media, err := a.storeMedia(ctx, user, reviewPNG(t), "reference.png")
	if err != nil {
		t.Fatal(err)
	}
	input := Row{"requestId": uuid.NewString(), "modelId": model, "content": "看图", "systemPrompt": "描述图片", "attachmentMediaIds": []string{str(media["id"])}}
	response := testRequest(a.Router(), "POST", "/api/text/requests", input, cookie)
	if response.Code != 200 {
		t.Fatal(response.Body)
	}
	a.executeGuarded(ctx, claimForTest(t, a, user))
	task, err := one(ctx, a.DB, "SELECT status,prompt_tokens,cached_tokens,completion_tokens,billed_micros FROM generation_tasks WHERE id=$1", input["requestId"])
	if err != nil || task["status"] != "succeeded" || integer(task["promptTokens"]) != 100 || integer(task["cachedTokens"]) != 80 || integer(task["completionTokens"]) != 5 || integer(task["billedMicros"]) != 50 {
		t.Fatalf("settlement: %v %v", task, err)
	}
	testBalance(t, a, user, moneyScale-50, 0)
	response = testRequest(a.Router(), "POST", "/api/text/requests", input, cookie)
	if response.Code != 200 || calls.Load() != 1 {
		t.Fatalf("replay duplicated request: %d calls=%d", response.Code, calls.Load())
	}
	testBalance(t, a, user, moneyScale-50, 0)
}

func TestOpenAIStreamPreservesSplitUsage(t *testing.T) {
	for _, test := range []struct {
		name   string
		events []string
		cached int64
	}{
		{"chat", []string{
			`{"choices":[{"delta":{"content":"完整输出"}}],"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":80}}}`,
			`{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":5}}`,
		}, 80},
		{"responses", []string{
			`{"type":"response.output_text.delta","delta":"完整输出"}`,
			`{"type":"response.in_progress","response":{"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":80}}}}`,
			`{"type":"response.completed","response":{"usage":{"output_tokens":5}}}`,
		}, 80},
		{"explicit_zero", []string{
			`{"choices":[{"delta":{"content":"完整输出"}}],"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":80}}}`,
			`{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":0}}}`,
		}, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				for _, event := range test.events {
					_, _ = fmt.Fprintf(w, "data: %s\n\n", event)
				}
			}))
			defer upstream.Close()
			req, err := http.NewRequestWithContext(context.Background(), "POST", upstream.URL, nil)
			if err != nil {
				t.Fatal(err)
			}
			a := &App{Config: Config{AllowPrivateHosts: true, MaxGenerated: 50 * 1024 * 1024}}
			result, err := a.streamText(context.Background(), req, channel{Protocol: "openai"}, Row{"probe": true})
			if err != nil || result.Text != "完整输出" || result.PromptTokens != 100 || result.CachedTokens != test.cached || result.CompletionTokens != 5 {
				t.Fatalf("split usage lost: %+v err=%v", result, err)
			}
		})
	}
}

func TestShutdownDoesNotReplayPartialText(t *testing.T) {
	a := testApp(t)
	if a.Redis == nil {
		t.Skip("需要 TEST_REDIS_ADDR")
	}
	ctx := context.Background()
	user, cookie := testUser(t, a, 3*moneyScale)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"已物化文本\"}}]}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer upstream.Close()
	model, _ := capabilityModel(t, a, "text", upstream.URL, moneyScale)
	id := uuid.NewString()
	response := testRequest(a.Router(), "POST", "/api/text/requests", Row{"requestId": id, "modelId": model, "content": "hello"}, cookie)
	if response.Code != 200 {
		t.Fatal(response.Body)
	}
	changed := a.addSink(id)
	defer a.removeSink(id, changed)
	task := claimForTest(t, a, user)
	root, stop := context.WithCancel(ctx)
	defer stop()
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.executeGuarded(root, task)
	}()
	var partial string
	wait := time.NewTimer(10 * time.Second)
	defer wait.Stop()
	for partial == "" {
		select {
		case <-changed:
		case <-wait.C:
			t.Fatal("文本未物化")
		}
		if err := a.DB.QueryRow(ctx, "SELECT partial_text FROM generation_tasks WHERE id=$1", id).Scan(&partial); err != nil {
			t.Fatal(err)
		}
	}
	if partial != "已物化文本" {
		t.Fatalf("partial=%q", partial)
	}
	a.shuttingDown.Store(true)
	stop()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("退出时流式任务未结束")
	}
	a.recoverTasks(ctx)
	row, err := one(ctx, a.DB, "SELECT status,attempt_count,partial_text FROM generation_tasks WHERE id=$1", id)
	if err != nil || row["status"] != "failed" || integer(row["attemptCount"]) != 1 || row["partialText"] != partial || calls.Load() != 1 {
		t.Fatalf("已物化文本被重排: %v calls=%d err=%v", row, calls.Load(), err)
	}
	testBalance(t, a, user, 3*moneyScale, 0)
}

func TestRetryRequiresCurrentCanvasWriteAccess(t *testing.T) {
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
	owner, _ := testUser(t, a, 0)
	editor, cookie := testUser(t, a, moneyScale)
	workspace, project := uuid.NewString(), uuid.NewString()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{"INSERT INTO workspaces(id,name,owner_id) VALUES($1,'团队',$2)", []any{workspace, owner}},
		{"INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'editor')", []any{workspace, owner, editor}},
		{"INSERT INTO canvas_projects(id,user_id,title,snapshot,workspace_id) VALUES($1,$2,'画布','{}',$3)", []any{project, owner, workspace}},
	} {
		if _, err := a.DB.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	for _, capability := range []string{"image", "video", "audio"} {
		t.Run(capability, func(t *testing.T) {
			if _, err := a.DB.Exec(ctx, "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'editor') ON CONFLICT(workspace_id,user_id) DO UPDATE SET role='editor'", workspace, editor); err != nil {
				t.Fatal(err)
			}
			model, _ := capabilityModel(t, a, capability, "http://localhost", 0)
			response := testRequest(a.Router(), "POST", "/api/generation-batches", Row{"requestId": uuid.NewString(), "modelId": model, "prompt": "test", "count": 1, "canvasProjectId": project}, cookie)
			if response.Code != 200 {
				t.Fatal(response.Body)
			}
			task, err := one(ctx, a.DB, "SELECT id FROM generation_tasks WHERE user_id=$1 AND model_id=$2", editor, model)
			if err != nil {
				t.Fatal(err)
			}
			id := str(task["id"])
			if err := a.cancelTask(ctx, id, editor, false); err != nil {
				t.Fatal(err)
			}
			for _, change := range []string{"UPDATE workspace_members SET role='viewer' WHERE workspace_id=$1 AND user_id=$2", "DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2"} {
				if _, err := a.DB.Exec(ctx, change, workspace, editor); err != nil {
					t.Fatal(err)
				}
				response = testRequest(a.Router(), "POST", "/api/generation-batches/tasks/"+id+"/retry", nil, cookie)
				if response.Code != 404 {
					t.Fatalf("revoked retry: %d %s", response.Code, response.Body.String())
				}
				row, err := one(ctx, a.DB, "SELECT run,status FROM generation_tasks WHERE id=$1", id)
				if err != nil || integer(row["run"]) != 1 || row["status"] != "canceled" {
					t.Fatalf("denied retry mutated task: %v %v", row, err)
				}
			}
			testBalance(t, a, editor, moneyScale, 0)
		})
	}
}
