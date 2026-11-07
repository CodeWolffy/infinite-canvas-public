package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
	"github.com/tmaxmax/go-sse"
)

func TestCanvasPersonalStateAndHistoryStayPrivate(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	owner, _ := testUser(t, a, 0)
	editor, _ := testUser(t, a, 0)
	projectID, historyID, mediaID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{"INSERT INTO canvas_projects(id,user_id,title,snapshot) VALUES($1,$2,'shared',$3)", []any{projectID, owner, jsonBytes(sharedCanvasSnapshot(canvasTestSnapshot("")))}},
		{"INSERT INTO canvas_members(project_id,user_id,role,status,invited_by) VALUES($1,$2,'editor','accepted',$3)", []any{projectID, editor, owner}},
		{"INSERT INTO media_objects(id,owner_id,object_key,original_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,'private.png','image/png',1,'hash')", []any{mediaID, owner, uuid.NewString()}},
	} {
		if _, err := a.DB.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	private := map[string]any{
		"viewport": map[string]any{"x": 25.0, "y": 10.0, "k": 2.0},
		"chatSessions": []any{map[string]any{"id": "private", "messages": []any{map[string]any{"content": "owner secret", "mediaId": mediaID}}}},
		"activeChatId": "private",
	}
	if err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		if err := saveCanvasPersonalState(ctx, tx, projectID, owner, private, nil); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "INSERT INTO canvas_project_history(id,project_id,user_id,title,snapshot) SELECT $1,id,user_id,title,snapshot FROM canvas_projects WHERE id=$2", historyID, projectID); err != nil {
			return err
		}
		return saveCanvasPersonalHistory(ctx, tx, projectID, historyID, owner)
	}); err != nil {
		t.Fatal(err)
	}
	ownerDetail, err := canvasProjectDetail(ctx, a.DB, projectID, owner, true)
	if err != nil || object(object(ownerDetail["snapshot"])["viewport"])["x"] != 25.0 {
		t.Fatalf("owner personal state missing: %v %v", ownerDetail, err)
	}
	editorDetail, err := canvasProjectDetail(ctx, a.DB, projectID, editor, true)
	if err != nil || len(object(editorDetail["snapshot"])["chatSessions"].([]any)) != 0 || object(object(editorDetail["snapshot"])["viewport"])["x"] != 0.0 {
		t.Fatalf("editor received owner personal state: %v %v", editorDetail, err)
	}
	shared, err := canvasProjectDetail(ctx, a.DB, projectID, owner, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"viewport", "chatSessions", "activeChatId"} {
		if _, present := object(shared["snapshot"])[key]; present {
			t.Fatalf("real-time detail contains private %s", key)
		}
	}
	// 媒体临时不可用不能阻塞个人视口或未改变的助手记录；改变助手内容仍需完整校验引用。
	if _, err := a.DB.Exec(ctx, "UPDATE media_objects SET status='deleting' WHERE id=$1", mediaID); err != nil {
		t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		return saveCanvasPersonalState(ctx, tx, projectID, owner, nil, map[string]any{"x": 30.0, "y": 20.0, "k": 1.0})
	}); err != nil {
		t.Fatalf("viewport-only save revalidated unchanged assistant media: %v", err)
	}
	if err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		return saveCanvasPersonalState(ctx, tx, projectID, owner, private, nil)
	}); err != nil {
		t.Fatalf("unchanged assistant state revalidated its media: %v", err)
	}
	changed := map[string]any{"chatSessions": []any{map[string]any{"id": "changed", "mediaId": mediaID}}}
	if err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		return saveCanvasPersonalState(ctx, tx, projectID, owner, changed, nil)
	}); err == nil {
		t.Fatal("changed assistant state skipped media validation")
	}
	if _, err := a.DB.Exec(ctx, "UPDATE media_objects SET status='ready' WHERE id=$1", mediaID); err != nil {
		t.Fatal(err)
	}
	if _, err := readableMedia(ctx, a.DB, mediaID, editor, false); err == nil {
		t.Fatal("collaborator can read private assistant media")
	}
	if err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		return saveCanvasPersonalState(ctx, tx, projectID, editor, private, nil)
	}); err == nil {
		t.Fatal("editor saved another user's private media")
	}
	if err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		return saveCanvasPersonalState(ctx, tx, projectID, owner, map[string]any{"chatSessions": []any{}, "activeChatId": nil}, nil)
	}); err != nil {
		t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		return restoreCanvasPersonalHistory(ctx, tx, projectID, historyID, owner)
	}); err != nil {
		t.Fatal(err)
	}
	ownerDetail, err = canvasProjectDetail(ctx, a.DB, projectID, owner, true)
	if err != nil || object(ownerDetail["snapshot"])["activeChatId"] != "private" {
		t.Fatalf("private history was not restored: %v %v", ownerDetail, err)
	}
	if _, err := a.DB.Exec(ctx, "DELETE FROM canvas_projects WHERE id=$1", projectID); err != nil {
		t.Fatal(err)
	}
	var refs int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM media_references WHERE owner_kind IN ('canvas_personal','canvas_history_personal') AND media_id=$1", mediaID).Scan(&refs); err != nil || refs != 0 {
		t.Fatalf("deleting canvas left private references: %d %v", refs, err)
	}
}

func TestCanvasPresenceRequiresCurrentAccessAndDeduplicatesTabs(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	owner, ownerCookie := testUser(t, a, 0)
	member, memberCookie := testUser(t, a, 0)
	projectID := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO canvas_projects(id,user_id,title,snapshot) VALUES($1,$2,'presence',$3)", projectID, owner, jsonBytes(sharedCanvasSnapshot(canvasTestSnapshot("")))); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO canvas_members(project_id,user_id,role,status,invited_by) VALUES($1,$2,'viewer','accepted',$3)", projectID, member, owner); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	for i := 0; i < 2; i++ {
		response := testRequest(router, "POST", "/api/canvas-projects/"+projectID+"/presence", map[string]any{"clientId": uuid.NewString()}, memberCookie)
		if response.Code != 204 {
			t.Fatalf("presence renewal failed: %d %s", response.Code, response.Body.String())
		}
	}
	response := testRequest(router, "POST", "/api/canvas-projects/"+projectID+"/presence", map[string]any{"clientId": uuid.NewString()}, ownerCookie)
	if response.Code != 204 {
		t.Fatalf("owner presence failed: %d %s", response.Code, response.Body.String())
	}
	members, err := canvasOnlineMembers(ctx, a.DB, projectID, owner)
	if err != nil || len(members) != 2 {
		t.Fatalf("tabs should be deduplicated to users: %v %v", members, err)
	}
	if _, err := a.DB.Exec(ctx, "UPDATE canvas_presence SET expires_at=now()-interval '1 second' WHERE user_id=$1", member); err != nil {
		t.Fatal(err)
	}
	members, err = canvasOnlineMembers(ctx, a.DB, projectID, owner)
	if err != nil || len(members) != 1 || members[0]["userId"] != owner {
		t.Fatalf("expired member remains online: %v %v", members, err)
	}
	if _, err := a.DB.Exec(ctx, "DELETE FROM canvas_members WHERE project_id=$1 AND user_id=$2", projectID, member); err != nil {
		t.Fatal(err)
	}
	response = testRequest(router, "POST", "/api/canvas-projects/"+projectID+"/presence", map[string]any{"clientId": uuid.NewString()}, memberCookie)
	if response.Code != 404 {
		t.Fatalf("revoked member renewed presence: %d %s", response.Code, response.Body.String())
	}
}

func TestCanvasHTTPSSERedactsPrivateStateAndClosesAfterRevocation(t *testing.T) {
	for _, crossInstance := range []bool{false, true} {
		name := "local"
		if crossInstance {
			name = "redis_cross_instance"
		}
		t.Run(name, func(t *testing.T) {
			writer := testApp(t)
			if crossInstance && writer.Redis == nil {
				t.Skip("跨实例验收需要 TEST_REDIS_ADDR")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			subscriber := writer
			if crossInstance {
				options := *writer.Redis.Options()
				subscriber = &App{DB: writer.DB, Redis: redis.NewClient(&options), Config: writer.Config}
				subscriber.startTaskEvents(ctx)
				defer func() {
					cancel()
					subscriber.workers.Wait()
					_ = subscriber.Redis.Close()
				}()
				// 通过真实广播确认订阅已建立，避免把启动竞态误判成协作事件丢失。
				readyKey := "canvas:test-ready:" + uuid.NewString()
				ready := subscriber.addSink(readyKey)
				defer subscriber.removeSink(readyKey, ready)
				tick := time.NewTicker(20 * time.Millisecond)
				defer tick.Stop()
			readyLoop:
				for {
					writer.publishBatchEvent(ctx, readyKey)
					select {
					case <-ready:
						break readyLoop
					case <-tick.C:
					case <-ctx.Done():
						t.Fatal("Redis 转发订阅未能建立")
					}
				}
			}
			owner, ownerCookie := testUser(t, writer, 0)
			viewer, viewerCookie := testUser(t, writer, 0)
			writerServer := httptest.NewServer(writer.Router())
			defer writerServer.Close()
			streamServer := writerServer
			if crossInstance {
				streamServer = httptest.NewServer(subscriber.Router())
				defer streamServer.Close()
			}
			request := func(method, path string, payload any, cookie *http.Cookie, status int) Row {
				t.Helper()
				req, err := http.NewRequestWithContext(ctx, method, writerServer.URL+path, bytes.NewReader(jsonBytes(payload)))
				if err != nil {
					t.Fatal(err)
				}
				req.Header.Set("Content-Type", "application/json")
				req.AddCookie(cookie)
				response, err := writerServer.Client().Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				body, err := io.ReadAll(response.Body)
				if err != nil || response.StatusCode != status {
					t.Fatalf("%s %s: status=%d body=%s err=%v", method, path, response.StatusCode, body, err)
				}
				var data Row
				if len(body) != 0 {
					if err := json.Unmarshal(body, &data); err != nil {
						t.Fatal(err)
					}
				}
				return data
			}
			initial := canvasTestSnapshot("")
			initial["chatSessions"] = []any{map[string]any{"id": "owner-private", "content": "owner-secret-must-not-stream"}}
			initial["activeChatId"] = "owner-private"
			created := object(request("POST", "/api/canvas-projects", Row{"title": "实时测试", "snapshot": initial}, ownerCookie, 200)["project"])
			projectID := str(created["id"])
			path := "/api/canvas-projects/" + projectID
			if _, err := writer.DB.Exec(ctx, "INSERT INTO canvas_members(project_id,user_id,role,status,invited_by) VALUES($1,$2,'viewer','accepted',$3)", projectID, viewer, owner); err != nil {
				t.Fatal(err)
			}
			clientID := uuid.NewString()
			request("POST", path+"/presence", Row{"clientId": clientID}, viewerCookie, 204)
			req, err := http.NewRequestWithContext(ctx, "GET", streamServer.URL+path+"/events", nil)
			if err != nil {
				t.Fatal(err)
			}
			req.AddCookie(viewerCookie)
			response, err := streamServer.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			contentType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
			if response.StatusCode != 200 || err != nil || contentType != "text/event-stream" {
				t.Fatalf("SSE negotiation failed: status=%d headers=%v", response.StatusCode, response.Header)
			}
			type received struct {
				event sse.Event
				err error
			}
			events := make(chan received, 8)
			go func() {
				defer close(events)
				for event, err := range sse.Read(response.Body, nil) {
					select {
					case events <- received{event, err}:
					case <-ctx.Done():
						return
					}
				}
			}()
			expect := func(kind string) Row {
				t.Helper()
				select {
				case item, ok := <-events:
					if !ok || item.err != nil || item.event.Type != kind {
						t.Fatalf("expected %s, received=%+v open=%v", kind, item, ok)
					}
					for _, private := range []string{"chatSessions", "activeChatId", "viewport", "owner-secret-must-not-stream"} {
						if strings.Contains(item.event.Data, private) {
							t.Fatalf("%s event disclosed %s: %s", kind, private, item.event.Data)
						}
					}
					var data Row
					if err := json.Unmarshal([]byte(item.event.Data), &data); err != nil {
						t.Fatal(err)
					}
					return data
				case <-ctx.Done():
					t.Fatalf("SSE did not deliver %s before the existing 30-second fallback", kind)
					return nil
				}
			}
			first := object(expect("snapshot")["project"])
			if first["id"] != projectID || first["accessRole"] != "viewer" || integer(first["revision"]) != 0 {
				t.Fatalf("initial authoritative snapshot missing: %v", first)
			}
			members := expect("presence")["members"].([]any)
			if len(members) != 1 || object(members[0])["userId"] != viewer {
				t.Fatalf("initial presence incorrect: %v", members)
			}
			changed := canvasTestSnapshot("")
			changed["nodes"].([]any)[0].(map[string]any)["title"] = "来自另一个实例的修改"
			changed["chatSessions"], changed["activeChatId"] = initial["chatSessions"], initial["activeChatId"]
			request("PUT", path, Row{"baseSnapshot": initial, "snapshot": changed, "expectedRevision": 0}, ownerCookie, 200)
			updated := object(expect("snapshot")["project"])
			if integer(updated["revision"]) != 1 || object(object(updated["snapshot"])["nodes"].([]any)[0])["title"] != "来自另一个实例的修改" {
				t.Fatalf("committed update did not reach SSE: %v", updated)
			}
			request("DELETE", path+"/presence/"+clientID, nil, viewerCookie, 204)
			if members := expect("presence")["members"].([]any); len(members) != 0 {
				t.Fatalf("presence departure was not broadcast: %v", members)
			}
			request("DELETE", path+"/members/"+viewer, nil, ownerCookie, 204)
			expect("unavailable")
			select {
			case item, ok := <-events:
				if ok {
					t.Fatalf("revoked SSE must end cleanly without another event: %+v", item)
				}
			case <-ctx.Done():
				t.Fatal("revoked SSE remained connected")
			}
		})
	}
}
