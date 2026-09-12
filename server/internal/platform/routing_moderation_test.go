package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func routingApp(t *testing.T) *App {
	t.Helper()
	a := testApp(t)
	if a.Redis == nil {
		t.Skip("需要 TEST_REDIS_ADDR")
	}
	settings := defaultSettings
	settings.UserRPM, settings.IPRPM = 0, 0
	if _, err := a.DB.Exec(context.Background(), "INSERT INTO app_settings(key,value) VALUES('platform',$1)", jsonBytes(settings)); err != nil {
		t.Fatal(err)
	}
	return a
}

func attachRoutingChannel(t *testing.T, a *App, model, endpoint string, priority int) string {
	t.Helper()
	id := uuid.NewString()
	secret, err := a.seal("backup-test-key")
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []struct{ sql string; args []any }{
		{"INSERT INTO channels(id,name,protocol,base_url,status) VALUES($1,'backup','openai',$2,'active')", []any{id, endpoint}},
		{"INSERT INTO channel_keys(channel_id,encrypted_api_key,key_hint) VALUES($1,$2,'已配置')", []any{id, secret}},
		{"INSERT INTO model_channels(model_id,channel_id,upstream_model,priority) VALUES($1,$2,'test',$3)", []any{model, id, priority}},
	} {
		if _, err = a.DB.Exec(context.Background(), q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	return id
}

func TestTaskFailoverKeepsOneHoldAndCharge(t *testing.T) {
	for _, failureStatus := range []int{429, 408} {
		t.Run(fmt.Sprint(failureStatus), func(t *testing.T) {
			a := routingApp(t)
			ctx := context.Background()
			user, cookie := testUser(t, a, 5*moneyScale)
			var failedCalls, succeededCalls atomic.Int32
			failed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				failedCalls.Add(1)
				w.WriteHeader(failureStatus)
				fmt.Fprint(w, `{"error":{"message":"temporary failure"}}`)
			}))
			defer failed.Close()
			backup := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				succeededCalls.Add(1)
				fmt.Fprint(w, `{"choices":[{"message":{"content":"完成"}}]}`)
			}))
			defer backup.Close()
			model, _ := capabilityModel(t, a, "text", failed.URL, moneyScale)
			attachRoutingChannel(t, a, model, backup.URL, -1)
			id := uuid.NewString()
			response := testRequest(a.Router(), "POST", "/api/text/requests", Row{"requestId": id, "modelId": model, "content": "hello"}, cookie)
			if response.Code != 200 { t.Fatal(response.Body.String()) }
			a.executeTask(ctx, claimForTest(t, a, user))
			testBalance(t, a, user, 4*moneyScale, moneyScale)
			// 用另一个 App 模拟重启，尝试计数和冻结额来自数据库。
			second := &App{DB: a.DB, Redis: a.Redis, Config: a.Config}
			second.executeTask(ctx, claimForTest(t, a, user))
			testBalance(t, a, user, 4*moneyScale, 0)
			var attempts, holds, charges, releases int
			var status string
			if err := a.DB.QueryRow(ctx, "SELECT attempt_count,status FROM generation_tasks WHERE id=$1", id).Scan(&attempts, &status); err != nil { t.Fatal(err) }
			if err := a.DB.QueryRow(ctx, "SELECT count(*) FILTER(WHERE kind='hold'),count(*) FILTER(WHERE kind='charge'),count(*) FILTER(WHERE kind='release') FROM wallet_entries WHERE user_id=$1", user).Scan(&holds, &charges, &releases); err != nil { t.Fatal(err) }
			if status != "succeeded" || attempts != 2 || holds != 1 || charges != 1 || releases != 0 || failedCalls.Load() != 1 || succeededCalls.Load() != 1 {
				t.Fatalf("status=%s attempts=%d ledger=%d/%d/%d calls=%d/%d", status, attempts, holds, charges, releases, failedCalls.Load(), succeededCalls.Load())
			}
		})
	}
}

func TestTaskRetryBudgetAndPolicyBoundaries(t *testing.T) {
	for _, test := range []struct{ name string; status int; body string; calls int; stream bool }{
		{"budget", 503, `{"error":{"message":"unavailable"}}`, 3, false},
		{"safety_service", 503, `{"error":{"message":"safety service unavailable"}}`, 3, false},
		{"policy", 400, `{"error":{"code":"content_policy","message":"policy"}}`, 1, false},
		{"partial", 200, "data: {\"choices\":[{\"delta\":{\"content\":\"已输出\"}}]}\n\ndata: {\"error\":{\"type\":\"rate_limit_error\",\"message\":\"limited\"}}\n\n", 1, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			a := routingApp(t)
			ctx := context.Background()
			user, cookie := testUser(t, a, 5*moneyScale)
			var calls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if test.stream { w.Header().Set("Content-Type", "text/event-stream") }
				w.WriteHeader(test.status)
				fmt.Fprint(w, test.body)
			}))
			defer upstream.Close()
			model, _ := capabilityModel(t, a, "text", upstream.URL, moneyScale)
			for i := 1; i <= 3; i++ { attachRoutingChannel(t, a, model, upstream.URL, -i) }
			id := uuid.NewString()
			response := testRequest(a.Router(), "POST", "/api/text/requests", Row{"requestId": id, "modelId": model, "content": "hello"}, cookie)
			if response.Code != 200 { t.Fatal(response.Body.String()) }
			for i := 0; i < test.calls; i++ { a.executeTask(ctx, claimForTest(t, a, user)) }
			row, err := one(ctx, a.DB, "SELECT status,attempt_count,partial_text FROM generation_tasks WHERE id=$1", id)
			if err != nil || row["status"] != "failed" || integer(row["attemptCount"]) != int64(test.calls) || calls.Load() != int32(test.calls) { t.Fatalf("%v calls=%d err=%v", row, calls.Load(), err) }
			if test.stream && row["partialText"] != "已输出" { t.Fatal("partial output lost") }
			testBalance(t, a, user, 5*moneyScale, 0)
		})
	}
}

func TestInvalidKeyDoesNotDisableItsChannel(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 3*moneyScale)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer test-key" {
			w.WriteHeader(401); fmt.Fprint(w, `{"error":{"message":"invalid key"}}`); return
		}
		if r.Header.Get("Authorization") != "Bearer good-key" { t.Error("unexpected key") }
		fmt.Fprint(w, `{"choices":[{"message":{"content":"完成"}}]}`)
	}))
	defer upstream.Close()
	model, channelID := capabilityModel(t, a, "text", upstream.URL, moneyScale)
	key, err := one(ctx, a.DB, "SELECT id FROM channel_keys WHERE channel_id=$1", channelID)
	if err != nil { t.Fatal(err) }
	if err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error { return a.addChannelKeys(ctx, tx, channelID, []string{"good-key", "good-key"}) }); err != nil { t.Fatal(err) }
	if _, err = a.DB.Exec(ctx, "UPDATE channel_keys SET last_used_at=now() WHERE channel_id=$1 AND id<>$2", channelID, key["id"]); err != nil { t.Fatal(err) }
	response := testRequest(a.Router(), "POST", "/api/text/requests", Row{"requestId": uuid.NewString(), "modelId": model, "content": "hello"}, cookie)
	if response.Code != 200 { t.Fatal(response.Body.String()) }
	a.executeTask(ctx, claimForTest(t, a, user))
	a.executeTask(ctx, claimForTest(t, a, user))
	var total, disabled int
	if err = a.DB.QueryRow(ctx, "SELECT count(*),count(*) FILTER(WHERE disabled_reason='authentication') FROM channel_keys WHERE channel_id=$1", channelID).Scan(&total, &disabled); err != nil || total != 2 || disabled != 1 { t.Fatalf("keys=%d disabled=%d: %v", total, disabled, err) }
	var active bool
	if err = a.DB.QueryRow(ctx, "SELECT status='active' AND auto_disabled_at IS NULL AND cooldown_until IS NULL FROM channels WHERE id=$1", channelID).Scan(&active); err != nil || !active { t.Fatal("one key disabled the entire channel", err) }
	testBalance(t, a, user, 2*moneyScale, 0)
}

func TestModerationRefundAndRejectedContext(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 5*moneyScale)
	admin, adminCookie := testUser(t, a, 0)
	if _, err := a.DB.Exec(ctx, "UPDATE users SET role='admin' WHERE id=$1", admin); err != nil { t.Fatal(err) }
	if _, err := a.DB.Exec(ctx, "INSERT INTO sensitive_words(pattern,action) VALUES('review-me','review'),('deny-me','block')"); err != nil { t.Fatal(err) }
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var payload Row
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil { t.Error(err) }
		if strings.Contains(string(jsonBytes(payload)), "review-me") { t.Error("rejected prompt leaked into subsequent context") }
		fmt.Fprint(w, `{"choices":[{"message":{"content":"完成"}}]}`)
	}))
	defer upstream.Close()
	model, _ := capabilityModel(t, a, "text", upstream.URL, moneyScale)
	id := uuid.NewString()
	router := a.Router()
	accepted := testRequest(router, "POST", "/api/text/requests", Row{"requestId": id, "modelId": model, "content": "review-me private"}, cookie)
	if accepted.Code != 200 { t.Fatal(accepted.Body.String()) }
	conversation := str(responseRow(t, accepted)["conversationId"])
	row, err := one(ctx, a.DB, "SELECT status,moderation_id FROM generation_tasks WHERE id=$1", id)
	if err != nil || row["status"] != "reviewing" || calls.Load() != 0 { t.Fatalf("not held for review: %v %v", row, err) }
	testBalance(t, a, user, 4*moneyScale, moneyScale)
	path := "/api/admin/moderation/"+str(row["moderationId"])+"/decision"
	if denied := testRequest(router, "POST", path, Row{"decision": "approved"}, cookie); denied.Code != 403 { t.Fatal("user approved own content") }
	for range 2 {
		if rejected := testRequest(router, "POST", path, Row{"decision": "rejected", "note": "请调整"}, adminCookie); rejected.Code != 204 { t.Fatal(rejected.Body.String()) }
	}
	testBalance(t, a, user, 5*moneyScale, 0)
	clean := testRequest(router, "POST", "/api/text/requests", Row{"requestId": uuid.NewString(), "modelId": model, "conversationId": conversation, "content": "hello"}, cookie)
	if clean.Code != 200 { t.Fatal(clean.Body.String()) }
	a.executeTask(ctx, claimForTest(t, a, user))
	testBalance(t, a, user, 4*moneyScale, 0)
	imageModel, _ := capabilityModel(t, a, "image", upstream.URL, moneyScale)
	blocked := testRequest(router, "POST", "/api/generation-batches", Row{"requestId": uuid.NewString(), "modelId": imageModel, "prompt": "review-me", "count": 1, "parameters": Row{"negativePrompt": "deny-me"}}, cookie)
	if blocked.Code != 400 { t.Fatal("image text parameters bypassed moderation") }
	pending := testRequest(router, "POST", "/api/generation-batches", Row{"requestId": uuid.NewString(), "modelId": imageModel, "prompt": "review-me", "count": 2}, cookie)
	if pending.Code != 200 { t.Fatal(pending.Body.String()) }
	testBalance(t, a, user, 2*moneyScale, 2*moneyScale)
	for _, value := range responseRow(t, pending)["tasks"].([]any) {
		task := object(value)
		if canceled := testRequest(router, "POST", "/api/generation-tasks/"+str(task["id"])+"/cancel", nil, cookie); canceled.Code != 204 { t.Fatal(canceled.Body.String()) }
	}
	testBalance(t, a, user, 4*moneyScale, 0)
	var canceledReviews int
	if err = a.DB.QueryRow(ctx, "SELECT count(*) FROM moderation_reviews WHERE user_id=$1 AND status='canceled'", user).Scan(&canceledReviews); err != nil || canceledReviews != 1 { t.Fatalf("canceled reviews=%d: %v", canceledReviews, err) }
}

func TestMonitorAutoRecoveryAndStatusAuth(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	_, userCookie := testUser(t, a, 0)
	var healthy atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !healthy.Load() { w.WriteHeader(503); fmt.Fprint(w, `{"error":{"message":"unavailable"}}`); return }
		fmt.Fprint(w, `{"choices":[{"message":{"content":"ok"}}]}`)
	}))
	defer upstream.Close()
	model, channelID := capabilityModel(t, a, "text", upstream.URL, 0)
	var binding string
	if err := a.DB.QueryRow(ctx, "SELECT id FROM model_channels WHERE channel_id=$1", channelID).Scan(&binding); err != nil { t.Fatal(err) }
	config := Monitoring{AutoDisableAfter: 3, BindingIDs: []string{binding}, Prompt: "probe"}
	if _, err := a.DB.Exec(ctx, "UPDATE channels SET monitoring=$2 WHERE id=$1", channelID, jsonBytes(config)); err != nil { t.Fatal(err) }
	probe := func() {
		row, err := one(ctx, a.DB, "UPDATE channels SET monitor_token=$2,monitor_deadline=now()+(timeout_ms*interval '1 millisecond') WHERE id=$1 RETURNING *", channelID, uuid.NewString())
		if err != nil { t.Fatal(err) }
		a.runMonitor(ctx, row)
	}
	for range 3 { probe() }
	var disabled bool
	if err := a.DB.QueryRow(ctx, "SELECT auto_disabled_at IS NOT NULL FROM channels WHERE id=$1", channelID).Scan(&disabled); err != nil || !disabled { t.Fatal("channel did not cool after three checks", err) }
	candidates, err := a.candidates(ctx, model, nil, nil)
	if err != nil || len(candidates) != 0 { t.Fatal("automatic disable was ignored", err) }
	healthy.Store(true)
	probe()
	if err = a.DB.QueryRow(ctx, "SELECT auto_disabled_at IS NOT NULL FROM channels WHERE id=$1", channelID).Scan(&disabled); err != nil || disabled { t.Fatal("channel did not recover", err) }
	if anonymous := testRequest(a.Router(), "GET", "/api/status/models", nil, nil); anonymous.Code != 401 { t.Fatal(anonymous.Body.String()) }
	response := testRequest(a.Router(), "GET", "/api/status/models", nil, userCookie)
	if response.Code != 200 { t.Fatal(response.Body.String()) }
	models := responseRow(t, response)["models"].([]any)
	if len(models) != 1 || object(models[0])["status"] != "available" || strings.Contains(response.Body.String(), "test-key") || strings.Contains(response.Body.String(), upstream.URL) { t.Fatal("public health is wrong or contains private routing data", response.Body.String()) }
	if _, err = a.DB.Exec(ctx, "UPDATE channels SET status='disabled' WHERE id=$1", channelID); err != nil { t.Fatal(err) }
	probe()
	var status string
	if err = a.DB.QueryRow(ctx, "SELECT status FROM channels WHERE id=$1", channelID).Scan(&status); err != nil || status != "disabled" { t.Fatal("manual disable was undone", err) }
}

func TestReferralRegistrationCreditsOnceAndRollsBackInvalidAdmission(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	inviter, _ := testUser(t, a, moneyScale)
	var code string
	if err := a.DB.QueryRow(ctx, "SELECT referral_code FROM users WHERE id=$1", inviter).Scan(&code); err != nil { t.Fatal(err) }
	settings := defaultSettings
	settings.ReferralEnabled, settings.ReferralReward = true, "0.25"
	if _, err := a.DB.Exec(ctx, "UPDATE app_settings SET value=$1 WHERE key='platform'", jsonBytes(settings)); err != nil { t.Fatal(err) }
	admission := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO invitations(code_hash,code_hint,created_by,max_uses) VALUES($1,'test',$2,1)", hash(admission), inviter); err != nil { t.Fatal(err) }
	router := a.Router()
	clientIP := fmt.Sprintf("203.0.113.1, 172.24.%d.%d, 127.0.0.1", rand.IntN(250)+1, rand.IntN(250)+1)
	register := func(invitation string) *httptest.ResponseRecorder {
		input := Row{"username": uuid.NewString(), "displayName": "新用户", "password": "test-password-only", "invitationCode": invitation, "referralCode": code}
		req := httptest.NewRequest("POST", "/api/auth/register", bytes.NewReader(jsonBytes(input)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Forwarded-For", clientIP)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}
	if bad := register("invalid-admission"); bad.Code != 400 { t.Fatal(bad.Body.String()) }
	testBalance(t, a, inviter, moneyScale, 0)
	accepted := register(admission)
	if accepted.Code != 200 { t.Fatal(accepted.Body.String()) }
	newUser := str(object(responseRow(t, accepted)["user"])["id"])
	if err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error { return a.creditReferral(ctx, tx, newUser, code) }); err != nil { t.Fatal(err) }
	testBalance(t, a, inviter, 1_250_000, 0)
	var credits int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM wallet_entries WHERE user_id=$1 AND kind='referral'", inviter).Scan(&credits); err != nil || credits != 1 { t.Fatalf("credits=%d: %v", credits, err) }
}

func TestExpiredTaskDoesNotReplayKnownRefusalOrCompletedUpstream(t *testing.T) {
	for _, completed := range []bool{false, true} {
		t.Run(fmt.Sprint(completed), func(t *testing.T) {
			a := routingApp(t)
			ctx := context.Background()
			user, cookie := testUser(t, a, 2*moneyScale)
			var calls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
			defer upstream.Close()
			model, channelID := capabilityModel(t, a, "text", upstream.URL, moneyScale)
			attachRoutingChannel(t, a, model, upstream.URL, -1)
			id := uuid.NewString()
			accepted := testRequest(a.Router(), "POST", "/api/text/requests", Row{"requestId": id, "modelId": model, "content": "hello"}, cookie)
			if accepted.Code != 200 { t.Fatal(accepted.Body.String()) }
			claimForTest(t, a, user)
			ch := channel{ID: channelID, Protocol: "openai", BaseURL: upstream.URL, APIKey: "test-key"}
			snapshot, err := a.seal(string(jsonBytes(ch)))
			if err != nil { t.Fatal(err) }
			if _, err = a.DB.Exec(ctx, "UPDATE generation_tasks SET channel_id=$2,channel_snapshot=$3,attempt_count=1,upstream_completed=$4,deadline=now()-interval '1 second' WHERE id=$1", id, channelID, snapshot, completed); err != nil { t.Fatal(err) }
			if !completed {
				if _, err = a.DB.Exec(ctx, "INSERT INTO request_logs(task_id,channel_id,type,status,error_category,error_message) VALUES($1,$2,'text','failed','content_policy','policy refusal')", id, channelID); err != nil { t.Fatal(err) }
			}
			a.recoverTasks(ctx)
			var status string
			if err = a.DB.QueryRow(ctx, "SELECT status FROM generation_tasks WHERE id=$1", id).Scan(&status); err != nil || status != "failed" || calls.Load() != 0 { t.Fatalf("status=%s calls=%d error=%v", status, calls.Load(), err) }
			testBalance(t, a, user, 2*moneyScale, 0)
		})
	}
}

func TestClaudeMessagesRequiresExplicitTokensAndStreamsUsage(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var input Row
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil { t.Error(err) }
		if r.URL.Path != "/v1/messages" || r.Header.Get("x-api-key") != "claude-test" || r.Header.Get("anthropic-version") != "2023-06-01" || integer(input["max_tokens"]) != 128 || input["system"] != "system" { t.Error("incorrect Messages request", input) }
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"content\":[],\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":3,\"cache_read_input_tokens\":2,\"output_tokens\":0}}}\n\n")
		fmt.Fprint(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"你好\"}}\n\n")
		fmt.Fprint(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"},\"usage\":{\"output_tokens\":4}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer upstream.Close()
	a := &App{Config: Config{AllowPrivateHosts: true, MaxGenerated: 50 * 1024 * 1024}}
	ch := channel{Protocol: "anthropic", APIKey: "claude-test", BaseURL: upstream.URL, UpstreamModel: "claude-test"}
	task := Row{"capability": "text", "prompt": "hello", "probe": true, "parameters": Row{"systemPrompt": "system"}}
	if _, err := a.generate(context.Background(), ch, task); err == nil || calls.Load() != 0 { t.Fatal("implicit Claude output limit was accepted") }
	task["parameters"] = Row{"systemPrompt": "system", "max_tokens": 128}
	result, err := a.generate(context.Background(), ch, task)
	if err != nil || result.Text != "你好" || result.PromptTokens != 15 || result.CachedTokens != 2 || result.CompletionTokens != 4 { t.Fatalf("result=%+v error=%v", result, err) }
}
