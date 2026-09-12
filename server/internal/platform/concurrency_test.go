package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"math/rand"
	"net/http/httptest"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexedwards/argon2id"
	"github.com/google/uuid"
)

func TestSuccessfulLoginsDoNotConsumeFailureQuota(t *testing.T) {
	a := testApp(t)
	if a.Redis == nil {
		t.Skip("需要 TEST_REDIS_ADDR")
	}
	id, _ := testUser(t, a, 0)
	password := "isolated-login-test"
	encoded, err := argon2id.CreateHash(password, argon2id.DefaultParams)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.Exec(context.Background(), "UPDATE users SET password_hash=$2 WHERE id=$1", id, encoded); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	// 测试机同一 IP 反复跑会命中登录/注册频控的 Redis 计数；用两跳代理头按运行隔离客户端 IP。
	clientIP := fmt.Sprintf("203.0.113.%d, 172.17.%d.%d, 127.0.0.1", rand.Intn(200)+1, rand.Intn(250)+1, rand.Intn(250)+1)
	login := func(password string) *httptest.ResponseRecorder {
		body := bytes.NewReader(jsonBytes(map[string]string{"username": id, "password": password}))
		req := httptest.NewRequest("POST", "/api/auth/login", body)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Forwarded-For", clientIP)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}
	for i := 0; i < 7; i++ {
		response := login(password)
		if response.Code != 200 {
			t.Fatalf("valid login %d: %d %s", i, response.Code, response.Body.String())
		}
	}
	for i := 0; i < 5; i++ {
		response := login("invalid")
		if response.Code != 401 {
			t.Fatalf("invalid login %d: %d %s", i, response.Code, response.Body.String())
		}
	}
	response := login("invalid")
	if response.Code != 429 {
		t.Fatalf("failure limit status=%d", response.Code)
	}
}

func TestAdminPasswordResetReturnsUserAndRevokesSessions(t *testing.T) {
	a := testApp(t)
	admin, adminCookie := testUser(t, a, 0)
	victim, victimCookie := testUser(t, a, 0)
	if _, err := a.DB.Exec(context.Background(), "UPDATE users SET role='admin' WHERE id=$1", admin); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	response := testRequest(router, "POST", "/api/admin/users/"+victim+"/reset-password", map[string]string{"temporaryPassword": "reset-password-test"}, adminCookie)
	if response.Code != 200 {
		t.Fatalf("reset status=%d %s", response.Code, response.Body)
	}
	var payload map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &payload)
	user := object(payload["user"])
	if user["id"] != victim || user["mustChangePassword"] != true || user["passwordHash"] != nil {
		t.Fatalf("invalid public user: %v", user)
	}
	response = testRequest(router, "GET", "/api/auth/me", nil, victimCookie)
	if response.Code != 401 {
		t.Fatalf("old session remains active: %d", response.Code)
	}
	announcement := map[string]any{"title": "测试公告", "content": "内容", "entries": []any{}, "forceAlert": true}
	response = testRequest(router, "PUT", "/api/admin/announcement", announcement, adminCookie)
	if response.Code != 200 {
		t.Fatal(response.Body)
	}
	_ = json.Unmarshal(response.Body.Bytes(), &payload)
	published := object(payload["announcement"])["publishedAt"]
	if published == nil || published == "" {
		t.Fatal("missing announcement revision")
	}
	announcement["forceAlert"] = false
	announcement["title"] = "修正文案"
	response = testRequest(router, "PUT", "/api/admin/announcement", announcement, adminCookie)
	_ = json.Unmarshal(response.Body.Bytes(), &payload)
	if object(payload["announcement"])["publishedAt"] != published {
		t.Fatal("silent update changed alert revision")
	}
}

func TestChannelSlotsSharedAcrossInstances(t *testing.T) {
	a := testApp(t)
	if a.Redis == nil {
		t.Skip("需要 TEST_REDIS_ADDR")
	}
	other := &App{Redis: a.Redis}
	c := channel{ID: uuid.NewString(), MaxConcurrency: 3}
	deadline := time.Now().Add(time.Minute)
	ctx := context.Background()
	var wg sync.WaitGroup
	held := make(chan Row, 40)
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			instance := a
			if index%2 == 1 {
				instance = other
			}
			task := Row{"id": uuid.NewString(), "run": 1}
			ok, err := instance.slot(ctx, c, task, deadline)
			if err != nil {
				t.Error(err)
			}
			if ok {
				held <- task
			}
		}(i)
	}
	wg.Wait()
	close(held)
	if len(held) != 3 {
		t.Fatalf("acquired=%d want=3", len(held))
	}
	for task := range held {
		a.releaseSlot(c, task)
	}
	task := Row{"id": uuid.NewString(), "run": 1}
	ok, err := a.slot(ctx, c, task, deadline)
	if err != nil || !ok {
		t.Fatalf("released slot unavailable: %v", err)
	}
	a.releaseSlot(c, task)
}

func TestInvitationCapacityUnderParallelRegistration(t *testing.T) {
	a := testApp(t)
	if a.Redis == nil {
		t.Skip("需要 TEST_REDIS_ADDR")
	}
	creator, _ := testUser(t, a, 0)
	ctx := context.Background()
	code := uuid.NewString()
	invitation := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO invitations(id,code_hash,code_hint,created_by,max_uses) VALUES($1,$2,'test',$3,1)", invitation, hash(code), creator); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	// 注册复用登录的 IP 频控（5 次/分钟）；测试机同 IP 反复跑会残留 Redis 计数，
	// 用两跳代理头给每次运行的每个请求分配唯一客户端 IP。
	run := rand.Intn(60000) + 1
	var wg sync.WaitGroup
	var success atomic.Int32
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			body := bytes.NewReader(jsonBytes(map[string]any{"username": uuid.NewString(), "displayName": "受邀用户", "password": "test-password-only", "invitationCode": code}))
			req := httptest.NewRequest("POST", "/api/auth/register", body)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Forwarded-For", fmt.Sprintf("203.0.113.%d, 172.16.%d.%d, 127.0.0.1", index+1, run/250+1, run%250+1))
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			if response.Code == 200 {
				success.Add(1)
			} else if response.Code != 400 {
				t.Errorf("status=%d body=%s", response.Code, response.Body.String())
			}
		}(i)
	}
	wg.Wait()
	if success.Load() != 1 {
		t.Fatalf("registrations=%d", success.Load())
	}
	var used, users int
	if err := a.DB.QueryRow(ctx, "SELECT used_count,(SELECT count(*) FROM invitation_uses WHERE invitation_id=$1) FROM invitations WHERE id=$1", invitation).Scan(&used, &users); err != nil || used != 1 || users != 1 {
		t.Fatalf("uses=%d registrations=%d err=%v", used, users, err)
	}
}

func fixtureModel(t *testing.T, a *App, capability, baseURL string) (string, string) {
	t.Helper()
	modelID, channelID := uuid.NewString(), uuid.NewString()
	ctx := context.Background()
	sealed, err := a.seal("original-test-key")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.Exec(ctx, "INSERT INTO models(id,name,display_name,capability,status,price_micros,config) VALUES($1,'test','测试模型',$2,'published',1000000,$3)", modelID, capability, jsonBytes(Row{"maxOutputTokens": 4096})); err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.Exec(ctx, "INSERT INTO channels(id,name,protocol,base_url,status) VALUES($1,'测试渠道','openai',$2,'active')", channelID, baseURL); err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.Exec(ctx, "INSERT INTO channel_keys(channel_id,encrypted_api_key,key_hint) VALUES($1,$2,'已配置')", channelID, sealed); err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.Exec(ctx, "INSERT INTO model_channels(model_id,channel_id,upstream_model) VALUES($1,$2,'test')", modelID, channelID); err != nil {
		t.Fatal(err)
	}
	return modelID, channelID
}
func claimForTest(t *testing.T, a *App, userID string) Row {
	t.Helper()
	task, err := one(context.Background(), a.DB, "UPDATE generation_tasks SET status='running',worker_token=$1,started_at=coalesce(started_at,now()),deadline=coalesce(deadline,now()+interval '480 seconds') WHERE id=(SELECT id FROM generation_tasks WHERE user_id=$2 AND status='queued' LIMIT 1) RETURNING *", uuid.NewString(), userID)
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func TestInsufficientBalanceRollsBackWholeBatch(t *testing.T) {
	a := testApp(t)
	if a.Redis == nil {
		t.Skip("需要 TEST_REDIS_ADDR")
	}
	id, cookie := testUser(t, a, 1500000)
	model, _ := fixtureModel(t, a, "image", "http://127.0.0.1:1")
	response := testRequest(a.Router(), "POST", "/api/generation-batches", map[string]any{"requestId": uuid.NewString(), "modelId": model, "prompt": "test", "count": 2}, cookie)
	if response.Code != 402 {
		t.Fatalf("status=%d %s", response.Code, response.Body)
	}
	testBalance(t, a, id, 1500000, 0)
	var tasks, entries int
	if err := a.DB.QueryRow(context.Background(), "SELECT (SELECT count(*) FROM generation_tasks),(SELECT count(*) FROM wallet_entries)").Scan(&tasks, &entries); err != nil || tasks != 0 || entries != 0 {
		t.Fatalf("partial batch tasks=%d entries=%d err=%v", tasks, entries, err)
	}
}

func TestVideoPollingRetainsAcceptedTaskAndCredentialSnapshot(t *testing.T) {
	a := testApp(t)
	if a.Redis == nil {
		t.Skip("需要 TEST_REDIS_ADDR")
	}
	id, cookie := testUser(t, a, 2*moneyScale)
	ctx := context.Background()
	var creates, polls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer original-test-key" {
			t.Error("accepted task lost its credential snapshot")
		}
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "POST" {
			creates.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "remote-video-1", "status": "queued"})
		} else {
			polls.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "remote-video-1", "status": "failed"})
		}
	}))
	defer upstream.Close()
	model, channel := fixtureModel(t, a, "video", upstream.URL)
	response := testRequest(a.Router(), "POST", "/api/generation-batches", map[string]any{"requestId": uuid.NewString(), "modelId": model, "prompt": "test", "count": 1}, cookie)
	if response.Code != 200 {
		t.Fatal(response.Body)
	}
	a.executeTask(ctx, claimForTest(t, a, id))
	var upstreamID, status string
	if err := a.DB.QueryRow(ctx, "SELECT upstream_task_id,status FROM generation_tasks WHERE user_id=$1", id).Scan(&upstreamID, &status); err != nil || upstreamID != "remote-video-1" || status != "queued" {
		t.Fatalf("task=%s %s err=%v", upstreamID, status, err)
	}
	testBalance(t, a, id, moneyScale, moneyScale)
	changed, _ := a.seal("changed-test-key")
	if _, err := a.DB.Exec(ctx, "UPDATE channel_keys SET encrypted_api_key=$2 WHERE channel_id=$1", channel, changed); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "UPDATE channels SET status='disabled' WHERE id=$1", channel); err != nil {
		t.Fatal(err)
	}
	secondInstance := &App{DB: a.DB, Redis: a.Redis, Config: a.Config}
	secondInstance.executeTask(ctx, claimForTest(t, a, id))
	if creates.Load() != 1 || polls.Load() != 1 {
		t.Fatalf("creates=%d polls=%d", creates.Load(), polls.Load())
	}
	testBalance(t, a, id, 2*moneyScale, 0)
}

func TestTextTaskPersistsHistoryAndReplaysWithoutCharge(t *testing.T) {
	a := testApp(t)
	if a.Redis == nil {
		t.Skip("需要 TEST_REDIS_ADDR")
	}
	id, cookie := testUser(t, a, 3*moneyScale)
	ctx := context.Background()
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		messages := body["messages"].([]any)
		if len(messages) < 2 || object(messages[0])["role"] != "system" {
			t.Error("missing system message")
		}
		calls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"role": "assistant", "content": "你好，创作者"}}}})
	}))
	defer upstream.Close()
	model, _ := fixtureModel(t, a, "text", upstream.URL)
	requestID := uuid.NewString()
	input := map[string]any{"requestId": requestID, "modelId": model, "content": "你好", "systemPrompt": "简洁回复"}
	router := a.Router()
	response := testRequest(router, "POST", "/api/text/requests", input, cookie)
	if response.Code != 200 {
		t.Fatalf("%d %s", response.Code, response.Body)
	}
	a.executeTask(ctx, claimForTest(t, a, id))
	response = testRequest(router, "POST", "/api/text/requests", input, cookie)
	if response.Code != 200 {
		t.Fatal(response.Body)
	}
	response = testRequest(router, "GET", "/api/text/requests/"+requestID, nil, cookie)
	if response.Code != 200 {
		t.Fatal(response.Body)
	}
	var detail map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &detail)
	if object(detail["message"])["content"] != "你好，创作者" {
		t.Fatalf("result=%v", detail)
	}
	testBalance(t, a, id, 2*moneyScale, 0)
	if calls.Load() != 1 {
		t.Fatalf("calls=%d", calls.Load())
	}
}
