package platform

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexedwards/argon2id"
	"github.com/google/uuid"
	"github.com/pquerna/otp/totp"
	"github.com/tmaxmax/go-sse"
)

func capabilityModel(t *testing.T, a *App, capability, endpoint string, price int64) (string, string) {
	t.Helper()
	ctx := context.Background()
	model, channel := uuid.NewString(), uuid.NewString()
	sealed, err := a.seal("test-key")
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{"INSERT INTO models(id,name,display_name,capability,status,price_micros) VALUES($1,'capability','capability',$2,'published',$3)", []any{model, capability, price}},
		{"INSERT INTO channels(id,name,protocol,base_url,status) VALUES($1,'test','openai',$2,'active')", []any{channel, endpoint}},
		{"INSERT INTO channel_keys(channel_id,encrypted_api_key,key_hint) VALUES($1,$2,'已配置')", []any{channel, sealed}},
		{"INSERT INTO model_channels(model_id,channel_id,upstream_model) VALUES($1,$2,'test')", []any{model, channel}},
	} {
		if _, err := a.DB.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	return model, channel
}

func responseRow(t *testing.T, response *httptest.ResponseRecorder) Row {
	t.Helper()
	var row Row
	if err := json.Unmarshal(response.Body.Bytes(), &row); err != nil {
		t.Fatalf("decode HTTP %d: %v", response.Code, err)
	}
	return row
}

func capabilityTask(t *testing.T, a *App, user string) Row {
	t.Helper()
	row, err := one(context.Background(), a.DB, "UPDATE generation_tasks SET status='running',worker_token=$1,started_at=now(),deadline=now()+interval '480 seconds' WHERE id=(SELECT id FROM generation_tasks WHERE user_id=$2 AND status='queued' ORDER BY queued_at LIMIT 1) RETURNING *", uuid.NewString(), user)
	if err != nil {
		t.Fatal(err)
	}
	return row
}

func TestGroupPermissionsQuoteAndPermanentBalance(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 10*moneyScale)
	admin, adminCookie := testUser(t, a, 0)
	if _, err := a.DB.Exec(ctx, "UPDATE users SET role='admin' WHERE id=$1", admin); err != nil {
		t.Fatal(err)
	}
	model, _ := capabilityModel(t, a, "image", "https://example.invalid", 2*moneyScale)
	other, _ := capabilityModel(t, a, "image", "https://example.invalid", 2*moneyScale)
	group := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO user_groups(id,name,discount) VALUES($1,'members',0.5)", group); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "UPDATE users SET group_id=$2 WHERE id=$1", user, group); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	policy := testRequest(router, "PUT", "/api/admin/user-groups/"+group+"/policy", map[string]any{"modelIds": []string{model}}, adminCookie)
	if policy.Code != 204 {
		t.Fatalf("policy: %d %s", policy.Code, policy.Body.String())
	}
	models := responseRow(t, testRequest(router, "GET", "/api/models", nil, cookie))["models"].([]any)
	if len(models) != 1 || object(models[0])["price"] != "1.000000" {
		t.Fatalf("model permissions/price: %v", models)
	}
	quote := testRequest(router, "POST", "/api/generation-quote", map[string]any{"modelId": model, "count": 2, "content": "hello"}, cookie)
	if quote.Code != 200 || object(responseRow(t, quote)["quote"])["estimatedHold"] != "2.000000" {
		t.Fatalf("quote: %d %s", quote.Code, quote.Body.String())
	}
	denied := testRequest(router, "POST", "/api/generation-batches", map[string]any{"requestId": uuid.NewString(), "modelId": other, "count": 1, "prompt": "hello"}, cookie)
	if denied.Code != 403 {
		t.Fatalf("direct request bypassed group: %d", denied.Code)
	}
	testBalance(t, a, user, 10*moneyScale, 0)
	if response := testRequest(router, "POST", "/api/user/group-grant/claim", nil, cookie); response.Code != 404 {
		t.Fatalf("periodic grant endpoint still enabled: %d", response.Code)
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO sensitive_words(pattern,action) VALUES('review-me','log')"); err != nil {
		t.Fatal(err)
	}
	allowed := testRequest(router, "POST", "/api/generation-batches", map[string]any{"requestId": uuid.NewString(), "modelId": model, "count": 1, "prompt": "review-me with private content"}, cookie)
	if allowed.Code != 200 {
		t.Fatalf("record-only blocked: %d %s", allowed.Code, allowed.Body.String())
	}
	var event string
	if err := a.DB.QueryRow(ctx, "SELECT detail::text FROM audit_logs WHERE actor_id=$1 AND action='sensitive.match'", user).Scan(&event); err != nil || strings.Contains(event, "private content") {
		t.Fatalf("review audit must omit full prompt: %v", err)
	}
}

func TestRetryAndDurationUseTheSamePrice(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 10*moneyScale)
	model, _ := capabilityModel(t, a, "video", "https://example.invalid", 0)
	if _, err := a.DB.Exec(ctx, "UPDATE models SET price_per_second=100000 WHERE id=$1", model); err != nil {
		t.Fatal(err)
	}
	group := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO user_groups(id,name,discount) VALUES($1,'discount',0.5)", group); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "UPDATE users SET group_id=$2 WHERE id=$1", user, group); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	for _, seconds := range []any{"6", 6} {
		response := testRequest(router, "POST", "/api/generation-batches", map[string]any{"requestId": uuid.NewString(), "modelId": model, "count": 1, "prompt": "hello", "parameters": map[string]any{"seconds": seconds}}, cookie)
		if response.Code != 200 {
			t.Fatalf("create %d %s", response.Code, response.Body.String())
		}
		id := str(object(responseRow(t, response)["tasks"].([]any)[0])["id"])
		if err := a.cancelTask(ctx, id, user, false); err != nil {
			t.Fatal(err)
		}
		retry := testRequest(router, "POST", "/api/generation-batches/tasks/"+id+"/retry", nil, cookie)
		if retry.Code != 200 || object(responseRow(t, retry)["task"])["price"] != "0.300000" {
			t.Fatalf("retry discount: %d %s", retry.Code, retry.Body.String())
		}
		if err := a.cancelTask(ctx, id, user, false); err != nil {
			t.Fatal(err)
		}
	}
	testBalance(t, a, user, 10*moneyScale, 0)
}

func TestMfaLoginSessionRevocationAndRecovery(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 0)
	password := "capability-password"
	encoded, err := argon2id.CreateHash(password, argon2id.DefaultParams)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.Exec(ctx, "UPDATE users SET password_hash=$2,role='admin' WHERE id=$1", user, encoded); err != nil {
		t.Fatal(err)
	}
	otherToken, err := a.session(ctx, a.DB, user)
	if err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	setup := testRequest(router, "POST", "/api/user/security/mfa/setup", map[string]string{"password": password}, cookie)
	if setup.Code != 200 {
		t.Fatalf("setup status %d", setup.Code)
	}
	secret := str(responseRow(t, setup)["secret"])
	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	enabled := testRequest(router, "POST", "/api/user/security/mfa/enable", map[string]string{"code": code}, cookie)
	if enabled.Code != 200 {
		t.Fatalf("enable status %d", enabled.Code)
	}
	recovery := str(responseRow(t, enabled)["recoveryCode"])
	if response := testRequest(router, "GET", "/api/auth/me", nil, &http.Cookie{Name: a.Config.CookieName, Value: otherToken}); response.Code != 401 {
		t.Fatal("old device remains logged in")
	}
	var username string
	if err = a.DB.QueryRow(ctx, "SELECT username FROM users WHERE id=$1", user).Scan(&username); err != nil {
		t.Fatal(err)
	}
	login := func() string {
		response := testRequest(router, "POST", "/api/auth/login", map[string]string{"username": username, "password": password}, nil)
		if response.Code != 200 || len(response.Result().Cookies()) != 0 {
			t.Fatalf("password alone issued a session: %d", response.Code)
		}
		return str(responseRow(t, response)["challenge"])
	}
	challenge := login()
	bad := testRequest(router, "POST", "/api/auth/mfa", map[string]string{"challenge": challenge, "code": "wrong"}, nil)
	if bad.Code != 400 {
		t.Fatalf("invalid mfa status %d", bad.Code)
	}
	code, err = totp.GenerateCode(secret, time.Now().Add(30*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	completed := testRequest(router, "POST", "/api/auth/mfa", map[string]string{"challenge": challenge, "code": code}, nil)
	if completed.Code != 200 || len(completed.Result().Cookies()) == 0 {
		t.Fatalf("mfa completion %d %s", completed.Code, completed.Body.String())
	}
	replay := testRequest(router, "POST", "/api/auth/mfa", map[string]string{"challenge": login(), "code": code}, nil)
	if replay.Code != 400 {
		t.Fatalf("TOTP replay accepted: %d", replay.Code)
	}
	recovered := testRequest(router, "POST", "/api/auth/mfa", map[string]string{"challenge": login(), "code": recovery}, nil)
	if recovered.Code != 200 {
		t.Fatalf("recovery status %d", recovered.Code)
	}
	var disabled bool
	if err = a.DB.QueryRow(ctx, "SELECT encrypted_totp_secret IS NULL AND mfa_recovery_hash IS NULL FROM users WHERE id=$1", user).Scan(&disabled); err != nil || !disabled {
		t.Fatal("recovery code was not consumed")
	}
}

func TestPasswordResetIsSingleUseAndKeepsMfa(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 0)
	email := "reset-" + uuid.NewString() + "@example.com"
	password, err := argon2id.CreateHash("old-password-value", argon2id.DefaultParams)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.Exec(ctx, "UPDATE users SET email=$2,email_verified_at=now(),password_hash=$3,encrypted_totp_secret='preserve-mfa' WHERE id=$1", user, email, password); err != nil {
		t.Fatal(err)
	}
	sealed, err := a.seal(string(jsonBytes(MailConfig{Enabled: true, Host: "smtp.example.invalid"})))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.Exec(ctx, "INSERT INTO app_settings(key,value) VALUES('mail',$1)", jsonBytes(Row{"sealed": sealed})); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	known := testRequest(router, "POST", "/api/auth/password-reset", map[string]string{"email": email}, nil)
	unknown := testRequest(router, "POST", "/api/auth/password-reset", map[string]string{"email": "unknown@example.com"}, nil)
	if known.Code != 200 || unknown.Code != 200 || known.Body.String() != unknown.Body.String() {
		t.Fatal("reset request exposes account existence")
	}
	var message string
	if err = a.DB.QueryRow(ctx, "SELECT encrypted_message FROM mail_outbox LIMIT 1").Scan(&message); err != nil {
		t.Fatal(err)
	}
	plain, err := a.unseal(message)
	if err != nil {
		t.Fatal(err)
	}
	var payload Row
	if err = json.Unmarshal([]byte(plain), &payload); err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(str(payload["body"]), "\n\n")
	link, err := url.Parse(parts[len(parts)-1])
	if err != nil {
		t.Fatal(err)
	}
	token := link.Query().Get("token")
	input := map[string]string{"token": token, "password": "new-password-value"}
	if response := testRequest(router, "POST", "/api/auth/password-reset/complete", input, nil); response.Code != 200 {
		t.Fatalf("reset status %d", response.Code)
	}
	if response := testRequest(router, "POST", "/api/auth/password-reset/complete", input, nil); response.Code != 400 {
		t.Fatalf("reset replay status %d", response.Code)
	}
	if response := testRequest(router, "GET", "/api/auth/me", nil, cookie); response.Code != 401 {
		t.Fatal("reset did not revoke session")
	}
	var preserved bool
	if err = a.DB.QueryRow(ctx, "SELECT encrypted_totp_secret IS NOT NULL FROM users WHERE id=$1", user).Scan(&preserved); err != nil || !preserved {
		t.Fatal("password reset disabled MFA")
	}
}

func TestTextSSEPersistsProgressBeforeSettlement(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 10*moneyScale)
	release := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"世界\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":3}}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	model, channel := capabilityModel(t, a, "text", upstream.URL, moneyScale)
	if _, err := a.DB.Exec(ctx, "UPDATE model_channels SET cost_config=$3 WHERE model_id=$1 AND channel_id=$2", model, channel, jsonBytes(Row{"fixed": "0.4"})); err != nil {
		t.Fatal(err)
	}
	requestID := uuid.NewString()
	router := a.Router()
	created := testRequest(router, "POST", "/api/text/requests", map[string]any{"requestId": requestID, "modelId": model, "content": "hello"}, cookie)
	if created.Code != 200 {
		t.Fatalf("create: %d %s", created.Code, created.Body.String())
	}
	task := capabilityTask(t, a, user)
	finished := make(chan struct{})
	go func() { defer close(finished); a.executeTask(ctx, task) }()
	server := httptest.NewServer(router)
	defer server.Close()
	streamCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(streamCtx, "GET", server.URL+"/api/text/requests/"+requestID+"/events", nil)
	req.AddCookie(cookie)
	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	sawPartial, sawFinal := false, false
	for event, err := range sse.Read(response.Body, nil) {
		if err != nil {
			t.Fatal(err)
		}
		if event.Type != "snapshot" {
			continue
		}
		var data Row
		if err = json.Unmarshal([]byte(event.Data), &data); err != nil {
			t.Fatal(err)
		}
		request := object(data["request"])
		if request["status"] == "running" && request["partialText"] == "你好" {
			sawPartial = true
			testBalance(t, a, user, 9*moneyScale, moneyScale)
			once.Do(func() { close(release) })
		}
		if request["status"] == "succeeded" {
			sawFinal = true
			if object(data["message"])["content"] != "你好世界" {
				t.Fatal("stream final content mismatch")
			}
			break
		}
	}
	if !sawPartial || !sawFinal {
		t.Fatalf("partial=%v final=%v", sawPartial, sawFinal)
	}
	<-finished
	testBalance(t, a, user, 9*moneyScale, 0)
	if _, err = a.DB.Exec(ctx, "DELETE FROM request_logs WHERE task_id=$1", requestID); err != nil {
		t.Fatal(err)
	}
	var cost int64
	if err = a.DB.QueryRow(ctx, "SELECT amount_micros FROM upstream_cost_entries WHERE task_id=$1", requestID).Scan(&cost); err != nil || cost != 400000 {
		t.Fatalf("cost did not survive log cleanup: %d %v", cost, err)
	}
}

func TestMonitoringChangesNotificationsAndCostReport(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	var revision atomic.Int32
	var failing atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/models"):
			models := []any{map[string]string{"id": "one"}}
			if revision.Load() > 0 {
				models = append(models, map[string]string{"id": "two"})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": models})
		case strings.HasSuffix(r.URL.Path, "/subscription"):
			fmt.Fprint(w, `{"hard_limit_usd":10}`)
		case strings.HasSuffix(r.URL.Path, "/usage"):
			fmt.Fprint(w, `{"total_usage":950}`)
		default:
			if failing.Load() {
				w.WriteHeader(503)
				fmt.Fprint(w, `{"error":{"message":"test failure"}}`)
				return
			}
			fmt.Fprint(w, `{"choices":[{"message":{"content":"OK"},"finish_reason":"stop"}]}`)
		}
	}))
	defer upstream.Close()
	model, channel := capabilityModel(t, a, "text", upstream.URL, 0)
	if _, err := a.DB.Exec(ctx, "UPDATE model_channels SET cost_config=$3 WHERE model_id=$1 AND channel_id=$2", model, channel, jsonBytes(Row{"fixed": "0.1"})); err != nil {
		t.Fatal(err)
	}
	threshold := "2"
	var bindingID string
	if err := a.DB.QueryRow(ctx, "SELECT id FROM model_channels WHERE model_id=$1 AND channel_id=$2", model, channel).Scan(&bindingID); err != nil {
		t.Fatal(err)
	}
	config := Monitoring{BindingIDs: []string{bindingID}, Prompt: "health", CheckModels: true, BalanceThreshold: &threshold}
	if _, err := a.DB.Exec(ctx, "UPDATE channels SET monitoring=$2 WHERE id=$1", channel, jsonBytes(config)); err != nil {
		t.Fatal(err)
	}
	run := func() {
		row, err := one(ctx, a.DB, "UPDATE channels SET monitor_token=$2,monitor_deadline=now()+interval '480 seconds' WHERE id=$1 RETURNING *", channel, uuid.NewString())
		if err != nil {
			t.Fatal(err)
		}
		a.runMonitor(ctx, row)
	}
	count := func() int {
		var n int
		if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM notifications").Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	run()
	if count() != 1 {
		t.Fatalf("expected first low-balance notice, got %d", count())
	}
	run()
	if count() != 1 {
		t.Fatal("unchanged state sent duplicate notice")
	}
	revision.Store(1)
	run()
	if count() != 2 {
		t.Fatalf("missing model change notice: %d", count())
	}
	failing.Store(true)
	run()
	if count() != 3 {
		t.Fatalf("missing health failure notice: %d", count())
	}
	run()
	if count() != 3 {
		t.Fatal("same failure sent duplicate notice")
	}
	admin, cookie := testUser(t, a, 0)
	if _, err := a.DB.Exec(ctx, "UPDATE users SET role='admin' WHERE id=$1", admin); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	costs := testRequest(router, "GET", "/api/admin/costs", nil, cookie)
	if costs.Code != 200 {
		t.Fatalf("cost report: %d %s", costs.Code, costs.Body.String())
	}
	totals := object(responseRow(t, costs)["totals"])
	if totals["knownCost"] != "0.300000" || integer(totals["unknownCount"]) != 2 {
		t.Fatalf("incorrect costs %v", totals)
	}
	_, ordinaryCookie := testUser(t, a, 0)
	if n := responseRow(t, testRequest(router, "GET", "/api/user/notifications", nil, ordinaryCookie))["notifications"].([]any); len(n) != 0 {
		t.Fatal("ordinary user can see administrator notifications")
	}
}

func TestAudioDurationBillingAndProbeIsolation(t *testing.T) {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("需要服务器同款 ffprobe")
	}
	a := testApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 10*moneyScale)
	wav, err := pcmWAV(make([]byte, 130000), 8000)
	if err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "audio/wav")
		_, _ = w.Write(wav)
	}))
	defer upstream.Close()
	model, channel := capabilityModel(t, a, "audio", upstream.URL, 0)
	if _, err = a.DB.Exec(ctx, "UPDATE models SET price_per_second=100000 WHERE id=$1", model); err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.Exec(ctx, "UPDATE model_channels SET cost_config=$3 WHERE model_id=$1 AND channel_id=$2", model, channel, jsonBytes(Row{"second": "0.05"})); err != nil {
		t.Fatal(err)
	}
	response := testRequest(a.Router(), "POST", "/api/generation-batches", map[string]any{"requestId": uuid.NewString(), "modelId": model, "count": 1, "prompt": "test", "parameters": map[string]string{"response_format": "wav"}}, cookie)
	if response.Code != 200 {
		t.Fatalf("create audio: %d %s", response.Code, response.Body.String())
	}
	task := capabilityTask(t, a, user)
	a.executeTask(ctx, task)
	stored, err := one(ctx, a.DB, "SELECT status,billed_micros,seconds::text FROM generation_tasks WHERE id=$1", task["id"])
	if err != nil {
		t.Fatal(err)
	}
	if stored["status"] != "succeeded" || integer(stored["billedMicros"]) != 812500 || stored["seconds"] != "8.125" {
		t.Fatalf("audio duration settlement: %v", stored)
	}
	testBalance(t, a, user, 10*moneyScale-812500, 0)
	var calls atomic.Int32
	trap := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(200) }))
	defer trap.Close()
	playlist := []byte("#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\n" + trap.URL + "/private\n#EXT-X-ENDLIST\n")
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if _, err = audioDuration(probeCtx, playlist); err == nil || calls.Load() != 0 {
		t.Fatal("duration probe accepted a playlist or fetched a network resource")
	}
}

func TestMonitorRecoveryAndMailFailureDoNotReplay(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	_, channel := capabilityModel(t, a, "text", "https://example.invalid", 0)
	token := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "UPDATE channels SET monitor_token=$2,monitor_deadline=now()-interval '1 second' WHERE id=$1", channel, token); err != nil {
		t.Fatal(err)
	}
	a.recoverMonitoring(ctx)
	a.recoverMonitoring(ctx)
	row, err := one(ctx, a.DB, "SELECT monitor_token,monitor_status FROM channels WHERE id=$1", channel)
	if err != nil {
		t.Fatal(err)
	}
	if row["monitorToken"] != nil || row["monitorStatus"] != "failed" {
		t.Fatal("expired monitor was not finalized")
	}
	var count int
	if err = a.DB.QueryRow(ctx, "SELECT count(*) FROM channel_checks WHERE channel_id=$1", channel).Scan(&count); err != nil || count != 1 {
		t.Fatalf("monitor replayed: %d %v", count, err)
	}
	config, err := a.seal(string(jsonBytes(MailConfig{Enabled: true, Host: "127.0.0.1", Port: 1, Mode: "tls", From: "test@example.com"})))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.Exec(ctx, "INSERT INTO app_settings(key,value) VALUES('mail',$1)", jsonBytes(Row{"sealed": config})); err != nil {
		t.Fatal(err)
	}
	if err = a.queueMail(ctx, a.DB, "test@example.com", "test", "test"); err != nil {
		t.Fatal(err)
	}
	a.deliverMail(ctx)
	a.deliverMail(ctx)
	var failed int
	if err = a.DB.QueryRow(ctx, "SELECT count(*) FROM mail_outbox WHERE status='failed'").Scan(&failed); err != nil || failed != 1 {
		t.Fatalf("failed mail was replayed: %d %v", failed, err)
	}
}

func TestEmailBindingRequiresProofAndSingleUseVerification(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 0)
	password := "email-binding-password"
	encoded, err := argon2id.CreateHash(password, argon2id.DefaultParams)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.Exec(ctx, "UPDATE users SET password_hash=$2 WHERE id=$1", user, encoded); err != nil {
		t.Fatal(err)
	}
	config, err := a.seal(string(jsonBytes(MailConfig{Enabled: true, Host: "smtp.example.invalid"})))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.Exec(ctx, "INSERT INTO app_settings(key,value) VALUES('mail',$1)", jsonBytes(Row{"sealed": config})); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	denied := testRequest(router, "POST", "/api/user/security/email", map[string]string{"password": "wrong", "email": "verified@example.test"}, cookie)
	if denied.Code != 400 {
		t.Fatalf("email binding accepted wrong password: %d", denied.Code)
	}
	requested := testRequest(router, "POST", "/api/user/security/email", map[string]string{"password": password, "email": "Verified@Example.test"}, cookie)
	if requested.Code != 200 {
		t.Fatalf("email binding request: %d %s", requested.Code, requested.Body.String())
	}
	var unbound bool
	if err = a.DB.QueryRow(ctx, "SELECT email IS NULL FROM users WHERE id=$1", user).Scan(&unbound); err != nil || !unbound {
		t.Fatal("email changed before verification")
	}
	var message string
	if err = a.DB.QueryRow(ctx, "SELECT encrypted_message FROM mail_outbox").Scan(&message); err != nil {
		t.Fatal(err)
	}
	plain, err := a.unseal(message)
	if err != nil {
		t.Fatal(err)
	}
	var payload Row
	if err = json.Unmarshal([]byte(plain), &payload); err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(str(payload["body"]), "\n\n")
	link, err := url.Parse(parts[len(parts)-1])
	if err != nil {
		t.Fatal(err)
	}
	body := map[string]string{"token": link.Query().Get("token")}
	if response := testRequest(router, "POST", "/api/auth/email/verify", body, nil); response.Code != 200 {
		t.Fatalf("verification: %d", response.Code)
	}
	if response := testRequest(router, "POST", "/api/auth/email/verify", body, nil); response.Code != 400 {
		t.Fatal("email verification link replay accepted")
	}
	expired, err := a.issueAuthToken(ctx, a.DB, user, "email", "other@example.test", encoded, -time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if response := testRequest(router, "POST", "/api/auth/email/verify", map[string]string{"token": expired}, nil); response.Code != 400 {
		t.Fatal("expired email verification accepted")
	}
	var email string
	if err = a.DB.QueryRow(ctx, "SELECT email FROM users WHERE id=$1", user).Scan(&email); err != nil || email != "verified@example.test" {
		t.Fatal("verified email changed incorrectly")
	}
}

func TestMetadataMonitoringRespectsChannelSlot(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1); fmt.Fprint(w, `{"data":[]}`) }))
	defer upstream.Close()
	_, id := capabilityModel(t, a, "text", upstream.URL, 0)
	row, err := one(ctx, a.DB, "UPDATE channels SET max_concurrency=1,monitoring=$2,monitor_token=$3,monitor_deadline=now()+interval '480 seconds' WHERE id=$1 RETURNING *", id, jsonBytes(Monitoring{CheckModels: true}), uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	ch, err := a.channelFromRow(row)
	if err != nil {
		t.Fatal(err)
	}
	held := Row{"id": uuid.NewString(), "run": 1}
	acquired, err := a.slot(ctx, ch, held, time.Now().Add(480*time.Second))
	if err != nil || !acquired {
		t.Fatal("cannot reserve test slot")
	}
	defer a.releaseSlot(ch, held)
	a.runMonitor(ctx, row)
	if requests.Load() != 0 {
		t.Fatal("metadata monitoring bypassed channel concurrency")
	}
	var released bool
	if err = a.DB.QueryRow(ctx, "SELECT monitor_token IS NULL AND next_check_at IS NOT NULL FROM channels WHERE id=$1", id).Scan(&released); err != nil || !released {
		t.Fatal("busy monitoring was not rescheduled")
	}
}

func TestOpsRetentionPermanentBalanceAlertsAndCostFilters(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 10*moneyScale)
	admin, adminCookie := testUser(t, a, 0)
	if _, err := a.DB.Exec(ctx, "UPDATE users SET role='admin' WHERE id=$1", admin); err != nil {
		t.Fatal(err)
	}
	// 此用例检查多绑定成本归属，不依赖外部 DNS 在共享检测截止前失败。
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, `{"error":{"message":"isolated probe failure"}}`)
	}))
	defer upstream.Close()
	model, channel := capabilityModel(t, a, "image", upstream.URL, 2*moneyScale)
	other, _ := capabilityModel(t, a, "image", upstream.URL, 2*moneyScale)
	if _, err := a.DB.Exec(ctx, "INSERT INTO model_channels(model_id,channel_id,upstream_model) VALUES($1,$2,'other')", other, channel); err != nil {
		t.Fatal(err)
	}
	group := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO user_groups(id,name,discount) VALUES($1,'members',1)", group); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "UPDATE users SET group_id=$2 WHERE id=$1", user, group); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	first := testRequest(router, "POST", "/api/generation-batches", map[string]any{"requestId": uuid.NewString(), "modelId": model, "count": 1, "prompt": "one"}, cookie)
	if first.Code != 200 {
		t.Fatalf("first hold: %d %s", first.Code, first.Body.String())
	}
	over := testRequest(router, "POST", "/api/generation-batches", map[string]any{"requestId": uuid.NewString(), "modelId": model, "count": 1, "prompt": "two"}, cookie)
	if over.Code != 200 {
		t.Fatalf("permanent balance blocked by a period: %d %s", over.Code, over.Body.String())
	}
	testBalance(t, a, user, 6*moneyScale, 4*moneyScale)

	old := time.Now().Add(-400 * 24 * time.Hour)
	for _, query := range []struct {
		sql  string
		args []any
	}{
		{"INSERT INTO channel_checks(id,channel_id,status,detail,duration_ms,created_at) VALUES($1,$2,'failed','{}',1,$3)", []any{uuid.NewString(), channel, old}},
		{"INSERT INTO notifications(id,event_key,kind,title,content,created_at) VALUES($1,'old-note','channel.health','old','old',$2)", []any{uuid.NewString(), old}},
		{"INSERT INTO audit_logs(actor_id,action,target,detail,created_at) VALUES($1,'channel.save','old','{}',$2)", []any{admin, old}},
		{"INSERT INTO audit_logs(actor_id,action,target,detail,created_at) VALUES($1,'cost.reconciled','keep','{}',$2)", []any{admin, old}},
		{"INSERT INTO upstream_cost_entries(id,channel_id,capability,amount_micros,source,status,created_at) VALUES($1,$2,'image',1,'configured','succeeded',$3)", []any{uuid.NewString(), channel, old}},
	} {
		if _, err := a.DB.Exec(ctx, query.sql, query.args...); err != nil {
			t.Fatal(err)
		}
	}
	a.cleanup(ctx)
	counts := map[string]int{}
	for _, item := range []string{"channel_checks", "notifications", "audit_logs", "upstream_cost_entries"} {
		var count int
		if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM "+item).Scan(&count); err != nil {
			t.Fatal(err)
		}
		counts[item] = count
	}
	if counts["channel_checks"] != 0 || counts["notifications"] != 0 || counts["audit_logs"] != 1 || counts["upstream_cost_entries"] != 1 {
		t.Fatalf("retention counts %v", counts)
	}

	status := testRequest(router, "GET", "/api/admin/status", nil, adminCookie)
	if status.Code != 200 || responseRow(t, status)["database"] != true {
		t.Fatalf("status: %d %s", status.Code, status.Body.String())
	}
	queued := testRequest(router, "POST", "/api/admin/channels/check-all", nil, adminCookie)
	if queued.Code != 200 {
		t.Fatalf("check-all: %d %s", queued.Code, queued.Body.String())
	}

	probeBindings, err := rows(ctx, a.DB, "SELECT id FROM model_channels WHERE channel_id=$1 AND model_id=ANY($2::text[]::uuid[])", channel, []string{model, other})
	if err != nil {
		t.Fatal(err)
	}
	config := Monitoring{Prompt: "probe"}
	for _, binding := range probeBindings {
		config.BindingIDs = append(config.BindingIDs, str(binding["id"]))
	}
	if _, err := a.DB.Exec(ctx, "UPDATE channels SET monitoring=$2 WHERE id=$1", channel, jsonBytes(config)); err != nil {
		t.Fatal(err)
	}
	row, err := one(ctx, a.DB, "UPDATE channels SET monitor_token=$2,monitor_deadline=now()+interval '1 second' WHERE id=$1 RETURNING *", channel, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	a.runMonitor(ctx, row)
	var probes int
	if err = a.DB.QueryRow(ctx, "SELECT count(*) FROM upstream_cost_entries WHERE note='渠道生成检测'").Scan(&probes); err != nil || probes != 2 {
		t.Fatalf("multi-model probes %d: %v", probes, err)
	}
	filtered := testRequest(router, "GET", "/api/admin/costs?source=unknown&channelId="+channel, nil, adminCookie)
	if filtered.Code != 200 || integer(object(responseRow(t, filtered)["totals"])["unknownCount"]) != 2 {
		t.Fatalf("cost filter: %d %s", filtered.Code, filtered.Body.String())
	}

	settings := defaultSettings
	settings.CheckinEnabled, settings.RewardMin, settings.RewardMax = true, "1", "1"
	if _, err = a.DB.Exec(ctx, "INSERT INTO app_settings(key,value) VALUES('platform',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", jsonBytes(settings)); err != nil {
		t.Fatal(err)
	}
	claimed := testRequest(router, "POST", "/api/user/checkin", nil, cookie)
	if claimed.Code != 200 {
		t.Fatalf("checkin: %d %s", claimed.Code, claimed.Body.String())
	}
	notes := responseRow(t, testRequest(router, "GET", "/api/user/notifications", nil, cookie))["notifications"].([]any)
	if len(notes) == 0 {
		t.Fatal("user did not receive checkin notice")
	}
	a.notifyNoChannel(ctx, model)
	a.notifyNoChannel(ctx, model)
	var adminNotes int
	if err = a.DB.QueryRow(ctx, "SELECT count(*) FROM notifications WHERE user_id IS NULL AND kind='channel.unavailable'").Scan(&adminNotes); err != nil || adminNotes != 1 {
		t.Fatalf("no-channel notice %d: %v", adminNotes, err)
	}
}

func TestStorageQuotaRejectsUploadAndGeneration(t *testing.T) {
	a := testApp(t)
	if a.S3 == nil {
		t.Skip("需要 TEST_MINIO_ADDR")
	}
	ctx := context.Background()
	user, cookie := testUser(t, a, 10*moneyScale)
	group := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO user_groups(id,name,discount,storage_quota_bytes) VALUES($1,'storage',1,1)", group); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "UPDATE users SET group_id=$2 WHERE id=$1", user, group); err != nil {
		t.Fatal(err)
	}
	var img bytes.Buffer
	if err := png.Encode(&img, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	denied, err := a.storeMedia(ctx, user, img.Bytes(), "tiny.png")
	if err == nil || denied != nil {
		t.Fatal("storeMedia should reject over-quota files")
	}
	var api *apiError
	if !errors.As(err, &api) || api.Code != "storage_quota" {
		t.Fatalf("storeMedia: %v", err)
	}
	if classified := classify(err); classified.Category != "storage_quota" {
		t.Fatalf("classify=%s", classified.Category)
	}
	router := a.Router()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("file", "tiny.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write(img.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", "/api/media", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.AddCookie(cookie)
	upload := httptest.NewRecorder()
	router.ServeHTTP(upload, req)
	if upload.Code != 413 || !strings.Contains(upload.Body.String(), "storage_quota") {
		t.Fatalf("upload: %d %s", upload.Code, upload.Body.String())
	}
	if a.Redis != nil {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]string{"b64_json": base64.StdEncoding.EncodeToString(img.Bytes())}}})
		}))
		defer upstream.Close()
		model, _ := capabilityModel(t, a, "image", upstream.URL, moneyScale)
		created := testRequest(router, "POST", "/api/generation-batches", map[string]any{"requestId": uuid.NewString(), "modelId": model, "count": 1, "prompt": "quota"}, cookie)
		if created.Code != 200 {
			t.Fatalf("create: %d %s", created.Code, created.Body.String())
		}
		task := capabilityTask(t, a, user)
		a.executeTask(ctx, task)
		row, err := one(ctx, a.DB, "SELECT status,error_code FROM generation_tasks WHERE id=$1", task["id"])
		if err != nil || row["status"] != "failed" || row["errorCode"] != "storage_quota" {
			t.Fatalf("task=%v err=%v", row, err)
		}
		testBalance(t, a, user, 10*moneyScale, 0)
	}
	if _, err = a.DB.Exec(ctx, "UPDATE user_groups SET storage_quota_bytes=0 WHERE id=$1", group); err != nil {
		t.Fatal(err)
	}
	saved, err := a.storeMedia(ctx, user, img.Bytes(), "ok.png")
	if err != nil || saved == nil {
		t.Fatalf("unlimited store: %v", err)
	}
	stats := testRequest(router, "GET", "/api/media/stats", nil, cookie)
	if stats.Code != 200 || integer(responseRow(t, stats)["quotaBytes"]) != 0 {
		t.Fatalf("stats: %d %s", stats.Code, stats.Body.String())
	}
}

func TestMultiUpstreamModelBindings(t *testing.T) {
	ctx := context.Background()
	a := testApp(t)
	admin, adminCookie := testUser(t, a, 0)
	if _, err := a.DB.Exec(ctx, "UPDATE users SET role='admin' WHERE id=$1", admin); err != nil {
		t.Fatal(err)
	}
	model, channel := capabilityModel(t, a, "image", "https://example.invalid", moneyScale)
	router := a.Router()

	// 1. 批量绑定同一渠道下的两个不同上游模型（例如 GPT Image 2.5 flare 和 sunburst）
	batchResp := testRequest(router, "POST", "/api/admin/models/"+model+"/channels/"+channel+"/batch", map[string]any{
		"upstreamModels": []string{"gpt-image-2.5-flare", "gpt-image-2.5-sunburst"},
		"priority":       10,
		"weight":         100,
		"enabled":        true,
	}, adminCookie)
	if batchResp.Code != 200 {
		t.Fatalf("batch bind failed: %d %s", batchResp.Code, batchResp.Body.String())
	}

	// 2. 查询绑定列表，验证是否生成了 2 条独立的绑定记录及各自的 bindingId
	listResp := testRequest(router, "GET", "/api/admin/models/"+model+"/channels", nil, adminCookie)
	if listResp.Code != 200 {
		t.Fatalf("list bindings failed: %d %s", listResp.Code, listResp.Body.String())
	}
	bindings, _ := responseRow(t, listResp)["bindings"].([]any)
	if len(bindings) < 2 {
		t.Fatalf("expected at least 2 bindings, got %d", len(bindings))
	}

	var flareBinding, sunburstBinding Row
	for _, item := range bindings {
		b := object(item)
		if str(b["upstreamModel"]) == "gpt-image-2.5-flare" {
			flareBinding = b
		} else if str(b["upstreamModel"]) == "gpt-image-2.5-sunburst" {
			sunburstBinding = b
		}
	}
	if flareBinding == nil || sunburstBinding == nil {
		t.Fatalf("missing flare or sunburst binding in %v", bindings)
	}
	if str(flareBinding["id"]) == "" || str(sunburstBinding["id"]) == "" || str(flareBinding["id"]) == str(sunburstBinding["id"]) {
		t.Fatalf("binding ids should be unique: flare=%s, sunburst=%s", str(flareBinding["id"]), str(sunburstBinding["id"]))
	}
	monitor := testRequest(router, "PUT", "/api/admin/channels/"+channel+"/monitoring", Row{"bindingIds": []string{str(flareBinding["id"]), str(sunburstBinding["id"])}, "prompt": "probe"}, adminCookie)
	if monitor.Code != http.StatusNoContent {
		t.Fatalf("monitor binding ids: %d %s", monitor.Code, monitor.Body.String())
	}

	// 3. 独立配置上游成本
	flareCost := testRequest(router, "PUT", "/api/admin/models/"+model+"/bindings/"+str(flareBinding["id"])+"/cost", map[string]string{
		"fixed": "0.05",
	}, adminCookie)
	if flareCost.Code != http.StatusNoContent {
		t.Fatalf("set flare cost: %d %s", flareCost.Code, flareCost.Body.String())
	}
	sunburstCost := testRequest(router, "PUT", "/api/admin/models/"+model+"/bindings/"+str(sunburstBinding["id"])+"/cost", map[string]string{
		"fixed": "0.20",
	}, adminCookie)
	if sunburstCost.Code != http.StatusNoContent {
		t.Fatalf("set sunburst cost: %d %s", sunburstCost.Code, sunburstCost.Body.String())
	}

	// 4. 验证 candidates 调度候选集中能独立获取这两个上游模型及其成本
	candidates, err := a.candidates(ctx, model, nil, nil)
	if err != nil {
		t.Fatalf("candidates: %v", err)
	}
	foundFlare := false
	foundSunburst := false
	for _, c := range candidates {
		if c.UpstreamModel == "gpt-image-2.5-flare" {
			foundFlare = true
			if c.CostConfig["fixed"] != "0.05" {
				t.Fatalf("flare cost config mismatch: %v", c.CostConfig)
			}
		}
		if c.UpstreamModel == "gpt-image-2.5-sunburst" {
			foundSunburst = true
			if c.CostConfig["fixed"] != "0.20" {
				t.Fatalf("sunburst cost config mismatch: %v", c.CostConfig)
			}
		}
	}
	if !foundFlare || !foundSunburst {
		t.Fatalf("candidates missing models: flare=%v, sunburst=%v", foundFlare, foundSunburst)
	}

	// 5. 精确删除单条绑定（例如移除 flare），验证 sunburst 依然保留
	delResp := testRequest(router, "DELETE", "/api/admin/models/"+model+"/bindings/"+str(flareBinding["id"]), nil, adminCookie)
	if delResp.Code != http.StatusNoContent {
		t.Fatalf("delete binding: %d %s", delResp.Code, delResp.Body.String())
	}
	remainingList := testRequest(router, "GET", "/api/admin/models/"+model+"/channels", nil, adminCookie)
	remaining, _ := responseRow(t, remainingList)["bindings"].([]any)
	hasFlare := false
	hasSunburst := false
	for _, item := range remaining {
		b := object(item)
		if str(b["upstreamModel"]) == "gpt-image-2.5-flare" {
			hasFlare = true
		}
		if str(b["upstreamModel"]) == "gpt-image-2.5-sunburst" {
			hasSunburst = true
		}
	}
	if hasFlare || !hasSunburst {
		t.Fatalf("delete failed: flare=%v, sunburst=%v", hasFlare, hasSunburst)
	}
}
