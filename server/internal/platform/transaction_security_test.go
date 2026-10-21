package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pquerna/otp/totp"
)

func TestUntrustedDecimalExponents(t *testing.T) {
	for _, value := range []string{"1e2147483647", "1e-2147483647", "1e999999999999999999999999", "0.1e-2147483648", "1e19", "1e-7"} {
		if _, err := amountUnits(value, moneyScale); err == nil {
			t.Fatalf("accepted unsafe or unrepresentable amount %s", value)
		}
		if explicitTextTokens(Row{"max_tokens": value}) != 0 {
			t.Fatalf("accepted unsafe token count %s", value)
		}
	}
	for _, value := range []string{"1e2147483647", "1e-2147483647"} {
		if _, err := paramSeconds(Row{"seconds": value}); err == nil {
			t.Fatal("unsafe duration accepted")
		}
	}
	for value, expected := range map[string]int64{"1e-6": 1, "+001.230000e1": 12300000, "-9223372036854.775808": -1 << 63, "0e2147483647": 0, strings.Repeat("0", 10000) + "1.00": moneyScale} {
		if got, err := amountUnits(value, moneyScale); err != nil || got != expected {
			t.Fatalf("representable amount rejected: %d %v", got, err)
		}
	}
}

func securityTextTask(t *testing.T, a *App, user string, price int64) Row {
	t.Helper()
	ctx := context.Background()
	model, _ := capabilityModel(t, a, "text", "https://example.invalid", price)
	conversation, id, token := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO conversations(id,user_id,title) VALUES($1,$2,'security')", conversation, user); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO generation_tasks(id,user_id,model_id,model_name,model_display_name,capability,prompt,price_micros,conversation_id,status,worker_token) VALUES($1,$2,$3,'capability','capability','text','security',$4,$5,'running',$6)", id, user, model, price, conversation, token); err != nil {
		t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		_, err := changeWallet(ctx, tx, user, "hold", id+":1", -price, price, "test")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	task, err := one(ctx, a.DB, "SELECT * FROM generation_tasks WHERE id=$1", id)
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func TestCancellationAndSubmissionAreExclusive(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	for range 12 {
		user, _ := testUser(t, a, moneyScale)
		task := securityTextTask(t, a, user, moneyScale)
		start := make(chan struct{})
		var submitted bool
		var submitErr, cancelErr error
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); <-start; submitted, submitErr = a.submitTask(ctx, task) }()
		go func() { defer wg.Done(); <-start; cancelErr = a.cancelTask(ctx, str(task["id"]), user, false) }()
		close(start)
		wg.Wait()
		if submitErr != nil {
			t.Fatal(submitErr)
		}
		if submitted {
			var api *apiError
			if !errors.As(cancelErr, &api) || api.Code != "task_submitted" {
				t.Fatalf("submitted task refunded: %v", cancelErr)
			}
			if err := a.finishTask(ctx, task, nil, &generationResult{Text: "paid result"}, nil); err != nil {
				t.Fatal(err)
			}
			testBalance(t, a, user, 0, 0)
		} else {
			if cancelErr != nil {
				t.Fatal(cancelErr)
			}
			testBalance(t, a, user, moneyScale, 0)
		}
		var entries int
		if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM wallet_entries WHERE user_id=$1 AND kind IN('charge','release')", user).Scan(&entries); err != nil || entries != 1 {
			t.Fatalf("settlement count=%d: %v", entries, err)
		}
	}
}

func TestSubmittedRequeuedTaskKeepsCancellationProtection(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	user, _ := testUser(t, a, moneyScale)
	task := securityTextTask(t, a, user, moneyScale)
	if submitted, err := a.submitTask(ctx, task); err != nil || !submitted {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "UPDATE generation_tasks SET status='queued',upstream_task_id='accepted-video',worker_token=NULL WHERE id=$1", task["id"]); err != nil {
		t.Fatal(err)
	}
	if err := a.cancelTask(ctx, str(task["id"]), user, false); err == nil {
		t.Fatal("submitted async job was refunded while queued")
	}
	if err := a.cancelTask(ctx, str(task["id"]), "", true); err == nil {
		t.Fatal("admin bypassed submission protection")
	}
	testBalance(t, a, user, 0, moneyScale)
}

func TestTextUpstreamSubmissionKeepsHoldUntilSettlement(t *testing.T) {
	a := routingApp(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	user, cookie := testUser(t, a, 2*moneyScale)
	started, release := make(chan struct{}), make(chan struct{})
	var startedOnce, releaseOnce sync.Once
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"paid\"}}]}\n\n")
		w.(http.Flusher).Flush()
		startedOnce.Do(func() { close(started) })
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\" result\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	defer releaseOnce.Do(func() { close(release) })
	model, _ := capabilityModel(t, a, "text", upstream.URL, moneyScale)
	id := uuid.NewString()
	router := a.Router()
	created := testRequest(router, "POST", "/api/text/requests", Row{"requestId": id, "modelId": model, "content": "hello"}, cookie)
	if created.Code != 200 {
		t.Fatal(created.Body.String())
	}
	task := capabilityTask(t, a, user)
	done := make(chan struct{})
	go func() { defer close(done); a.executeGuarded(ctx, task) }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("text upstream did not start")
	}
	response := testRequest(router, "POST", "/api/generation-tasks/"+id+"/cancel", Row{}, cookie)
	if response.Code != 409 || responseRow(t, response)["error"] != "task_submitted" {
		t.Fatalf("submitted text cancellation: %d %s", response.Code, response.Body.String())
	}
	testBalance(t, a, user, moneyScale, moneyScale)
	releaseOnce.Do(func() { close(release) })
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("submitted text did not settle")
	}
	var status, output string
	if err := a.DB.QueryRow(ctx, "SELECT t.status,m.content FROM generation_tasks t JOIN messages m ON m.id=t.response_message_id WHERE t.id=$1", id).Scan(&status, &output); err != nil || status != "succeeded" || output != "paid result" {
		t.Fatalf("submitted text result %s %q: %v", status, output, err)
	}
	testBalance(t, a, user, moneyScale, 0)
}

func TestDebtBlocksNewTasksAndCreditsRepayIt(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, moneyScale)
	queued := securityTextTask(t, a, user, 0)
	submitted := securityTextTask(t, a, user, 0)
	if ok, err := a.submitTask(ctx, submitted); err != nil || !ok {
		t.Fatal(err)
	}
	model, _ := capabilityModel(t, a, "image", "https://example.invalid", 0)
	text, _ := capabilityModel(t, a, "text", "https://example.invalid", 0)
	router := a.Router()
	input := Row{"requestId": uuid.NewString(), "modelId": model, "prompt": "free", "count": 1}
	created := testRequest(router, "POST", "/api/generation-batches", input, cookie)
	if created.Code != 200 { t.Fatal(created.Body.String()) }
	id := str(object(responseRow(t, created)["tasks"].([]any)[0])["id"])
	if err := a.cancelTask(ctx, id, user, false); err != nil { t.Fatal(err) }
	if err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		_, err := changeWallet(ctx, tx, user, "charge", "over-budget", -2*moneyScale, 0, "actual cost")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if replay := testRequest(router, "POST", "/api/generation-batches", input, cookie); replay.Code != 200 { t.Fatal("debt blocked an idempotent read") }
	if retry := testRequest(router, "POST", "/api/generation-batches/tasks/"+id+"/retry", nil, cookie); retry.Code != 402 { t.Fatal("debt allowed a free retry") }
	for path, payload := range map[string]Row{
		"/api/generation-batches": {"requestId": uuid.NewString(), "modelId": model, "prompt": "free", "count": 1},
		"/api/text/requests": {"requestId": uuid.NewString(), "modelId": text, "content": "free"},
	} {
		response := testRequest(router, "POST", path, payload, cookie)
		if response.Code != 402 || responseRow(t, response)["error"] != "wallet_in_debt" {
			t.Fatalf("debt did not block %s: %d %s", path, response.Code, response.Body.String())
		}
	}
	if ok, err := a.submitTask(ctx, queued); ok || err == nil {
		t.Fatal("unsubmitted queued task dispatched while in debt")
	}
	if ok, err := a.submitTask(ctx, submitted); err != nil || !ok {
		t.Fatal("already submitted task could not continue")
	}
	for i := range 2 {
		if err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			_, err := changeWallet(ctx, tx, user, "recharge", str(i), moneyScale/2, 0, "repay")
			return err
		}); err != nil {
			t.Fatal(err)
		}
		testBalance(t, a, user, -moneyScale+int64(i+1)*(moneyScale/2), 0)
	}
	if err := requireNoDebt(ctx, a.DB, user); err != nil {
		t.Fatal(err)
	}
}

func TestTextBudgetIncludesDenseTextAndImageAttachments(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, moneyScale)
	model, _ := capabilityModel(t, a, "text", "https://example.invalid", 0)
	if _, err := a.DB.Exec(ctx, `UPDATE models SET input_price_per_million=1000000,output_price_per_million=1000000,config='{"maxOutputTokens":128,"imageInput":true}' WHERE id=$1`, model); err != nil { t.Fatal(err) }
	media := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO media_objects(id,owner_id,object_key,original_name,mime_type,byte_size,sha256) VALUES($1::uuid,$2,$1::text,'image.png','image/png',12,'hash')", media, user); err != nil { t.Fatal(err) }
	router := a.Router()
	quote := Row{"modelId": model, "count": 1, "content": "汉字", "systemPrompt": "policy", "attachmentMediaIds": []string{media}}
	quoted := testRequest(router, "POST", "/api/generation-quote", quote, cookie)
	// 1024 开销 + 6 字节文字 + 6 字节系统提示 + 16 base64 字节 + 128 输出预算。
	if quoted.Code != 200 || object(responseRow(t, quoted)["quote"])["estimatedHold"] != "0.00118" { t.Fatalf("quote: %d %s", quoted.Code, quoted.Body.String()) }
	input := Row{"requestId": uuid.NewString(), "modelId": model, "content": "汉字", "systemPrompt": "policy", "attachmentMediaIds": []string{media}}
	created := testRequest(router, "POST", "/api/text/requests", input, cookie)
	if created.Code != 200 { t.Fatal(created.Body.String()) }
	testBalance(t, a, user, moneyScale-1180, 1180)
	conversation := str(responseRow(t, created)["conversationId"])
	estimate, err := promptEstimate(ctx, a.DB, conversation, "", "policy")
	if err != nil || estimate != 1052 { t.Fatalf("history image budget=%d: %v", estimate, err) }
	_, otherCookie := testUser(t, a, moneyScale)
	if response := testRequest(router, "POST", "/api/generation-quote", quote, otherCookie); response.Code != 400 { t.Fatal("inaccessible image quoted") }
}

func TestPerSecondAudioCannotCreateQuoteOrRetry(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, moneyScale)
	model, _ := capabilityModel(t, a, "audio", "https://example.invalid", 0)
	router := a.Router()
	input := Row{"requestId": uuid.NewString(), "modelId": model, "count": 1, "prompt": "audio"}
	created := testRequest(router, "POST", "/api/generation-batches", input, cookie)
	if created.Code != 200 {
		t.Fatal(created.Body.String())
	}
	id := str(object(responseRow(t, created)["tasks"].([]any)[0])["id"])
	if err := a.cancelTask(ctx, id, user, false); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "UPDATE models SET price_per_second=100000 WHERE id=$1", model); err != nil {
		t.Fatal(err)
	}
	input["requestId"], input["parameters"] = uuid.NewString(), Row{"seconds": "0.000001"}
	for path, payload := range map[string]any{
		"/api/generation-batches": input,
		"/api/generation-quote": Row{"modelId": model, "count": 1, "parameters": Row{"seconds": "0.000001"}},
		"/api/generation-batches/tasks/"+id+"/retry": nil,
	} {
		if response := testRequest(router, "POST", path, payload, cookie); response.Code != 400 {
			t.Fatalf("per-second audio accepted: %s %d %s", path, response.Code, response.Body.String())
		}
	}
	listed := testRequest(router, "GET", "/api/models", nil, cookie)
	if listed.Code != 200 || len(responseRow(t, listed)["models"].([]any)) != 0 {
		t.Fatal("unbounded audio remained available")
	}
	testBalance(t, a, user, moneyScale, 0)
}

func TestFinancialAdminEntrypointsRequireProof(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	admin, cookie, password := testAdmin(t, a)
	victim, _ := testUser(t, a, 0)
	model, channel := capabilityModel(t, a, "image", "https://example.invalid", moneyScale)
	var group string
	if err := a.DB.QueryRow(ctx, "SELECT id FROM user_groups LIMIT 1").Scan(&group); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	for _, item := range []struct { method, path, table string; payload Row }{
		{"POST", "/api/admin/users", "users", Row{"username": "security-admin", "displayName": "security", "temporaryPassword": "Security-password-42", "role": "admin"}},
		{"POST", "/api/admin/redeem-codes", "redeem_codes", Row{"amount": "1", "maxUses": 1}},
		{"POST", "/api/admin/models", "models", Row{"name": "security", "displayName": "security", "capability": "image", "status": "published", "price": "0"}},
		{"PUT", "/api/admin/models/"+model, "models", Row{"name": "security-existing", "displayName": "security", "capability": "image", "status": "draft", "price": "0"}},
		{"PATCH", "/api/admin/models/"+model+"/status", "models", Row{"status": "published"}},
		{"PUT", "/api/admin/models/"+model+"/channels/"+channel, "model_channels", Row{"upstreamModel": "security-single", "weight": 100, "enabled": true}},
		{"POST", "/api/admin/models/"+model+"/channels/"+channel+"/batch", "model_channels", Row{"upstreamModels": []string{"security-batch"}, "weight": 100, "enabled": true}},
		{"POST", "/api/admin/user-groups", "user_groups", Row{"name": "security-free", "discount": "0"}},
		{"PUT", "/api/admin/user-groups/"+group, "user_groups", Row{"name": "verified-default", "discount": "0"}},
		{"PATCH", "/api/admin/users/"+victim+"/group", "users", Row{"groupId": group}},
		{"PUT", "/api/admin/user-groups/"+group+"/policy", "user_groups", Row{"modelIds": []string{model}}},
	} {
		// 每个入口独立验证凭据；失败次数频控另有专项用例，不能让前一入口耗尽额度。
		if err := a.Redis.Del(ctx, "ic:proof:user:"+admin, "ic:proof:ip:"+hash("192.0.2.1")).Err(); err != nil {
			t.Fatal(err)
		}
		for _, proof := range []any{nil, securityProof{Password: "wrong-password"}} {
			var before, after []byte
			query := "SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY id),'[]') FROM " + item.table + " v"
			if err := a.DB.QueryRow(ctx, query).Scan(&before); err != nil { t.Fatal(err) }
			item.payload["securityProof"] = proof
			response := testRequest(router, item.method, item.path, item.payload, cookie)
			if response.Code != 400 { t.Fatalf("proof bypass: %s %d %s", item.path, response.Code, response.Body.String()) }
			if err := a.DB.QueryRow(ctx, query).Scan(&after); err != nil || !bytes.Equal(before, after) { t.Fatalf("failed proof wrote %s: %v", item.table, err) }
		}
		item.payload["securityProof"] = securityProof{Password: password}
		if response := testRequest(router, item.method, item.path, item.payload, cookie); response.Code != 200 && response.Code != 204 {
			t.Fatalf("valid proof failed: %s %d %s", item.path, response.Code, response.Body.String())
		}
	}
	secret := "JBSWY3DPEHPK3PXP"
	sealed, err := a.seal(secret)
	if err != nil { t.Fatal(err) }
	if _, err = a.DB.Exec(ctx, "UPDATE users SET encrypted_totp_secret=$2,totp_last_step=-1 WHERE id=$1", admin, sealed); err != nil { t.Fatal(err) }
	payload := Row{"amount": "1", "maxUses": 1, "securityProof": securityProof{Password: password, Code: "wrong"}}
	if response := testRequest(router, "POST", "/api/admin/redeem-codes", payload, cookie); response.Code != 400 { t.Fatal("MFA bypassed") }
	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil { t.Fatal(err) }
	payload["securityProof"] = securityProof{Password: password, Code: code}
	if response := testRequest(router, "POST", "/api/admin/redeem-codes", payload, cookie); response.Code != 200 { t.Fatal(response.Body.String()) }
	var audit string
	if err := a.DB.QueryRow(ctx, "SELECT coalesce(jsonb_agg(detail)::text,'') FROM audit_logs WHERE actor_id=$1", admin).Scan(&audit); err != nil { t.Fatal(err) }
	if strings.Contains(audit, password) || strings.Contains(audit, `"code"`) || strings.Contains(audit, "securityProof") { t.Fatal("credentials leaked into audit") }
}

func TestUnverifiedPlaygroundCannotConsumeUpstream(t *testing.T) {
	a := testApp(t)
	_, cookie, _ := testAdmin(t, a)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	_, channel := capabilityModel(t, a, "text", upstream.URL, 0)
	input := Row{"channelId": channel, "model": "test", "prompt": "hello"}
	for _, proof := range []any{nil, securityProof{Password: "wrong-password"}} {
		input["securityProof"] = proof
		response := testRequest(a.Router(), "POST", "/api/admin/playground/test", input, cookie)
		if response.Code != 400 {
			t.Fatalf("playground proof bypass: %d %s", response.Code, response.Body.String())
		}
	}
	var costs int
	if err := a.DB.QueryRow(context.Background(), "SELECT count(*) FROM upstream_cost_entries WHERE channel_id=$1", channel).Scan(&costs); err != nil || costs != 0 || calls.Load() != 0 {
		t.Fatalf("unverified probe consumed upstream: costs=%d calls=%d err=%v", costs, calls.Load(), err)
	}
}

func TestChangingChannelDestinationRequiresProof(t *testing.T) {
	a := testApp(t)
	admin, cookie, password := testAdmin(t, a)
	var originalCalls, destinationCalls atomic.Int32
	upstream := func(counter *atomic.Int32) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer test-key" { t.Error("unexpected credential") }
			counter.Add(1)
			_ = json.NewEncoder(w).Encode(Row{"data": []Row{{"id": "test"}}})
		}))
	}
	original, destination := upstream(&originalCalls), upstream(&destinationCalls)
	defer original.Close()
	defer destination.Close()
	_, channel := capabilityModel(t, a, "image", original.URL, 0)
	payload := channelCapabilityInput("image")
	payload["baseUrl"], payload["apiKeys"] = destination.URL, []string{}
	router := a.Router()
	for _, proof := range []any{nil, securityProof{Password: "wrong-password"}} {
		payload["securityProof"] = proof
		if response := testRequest(router, "PUT", "/api/admin/channels/"+channel, payload, cookie); response.Code != 400 { t.Fatal("destination changed without proof") }
	}
	if response := testRequest(router, "POST", "/api/admin/channels/"+channel+"/models", nil, cookie); response.Code != 200 { t.Fatal(response.Body.String()) }
	if originalCalls.Load() != 1 || destinationCalls.Load() != 0 { t.Fatal("existing key sent to unverified destination") }
	payload["securityProof"] = securityProof{Password: password}
	if response := testRequest(router, "PUT", "/api/admin/channels/"+channel, payload, cookie); response.Code != 200 { t.Fatal(response.Body.String()) }
	if response := testRequest(router, "POST", "/api/admin/channels/"+channel+"/models", nil, cookie); response.Code != 200 { t.Fatal(response.Body.String()) }
	if destinationCalls.Load() != 1 { t.Fatal("authorized destination not used") }
	var audit string
	if err := a.DB.QueryRow(context.Background(), "SELECT detail::text FROM audit_logs WHERE actor_id=$1 AND action='channel.destination'", admin).Scan(&audit); err != nil || strings.Contains(audit, password) || strings.Contains(audit, "test-key") { t.Fatalf("unsafe destination audit: %v", err) }
}

func TestTransactionSecurityMigrationPreservesNonemptyDatabase(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	user, _ := testUser(t, a, 2*moneyScale)
	task := securityTextTask(t, a, user, moneyScale)
	if _, err := a.DB.Exec(ctx, "UPDATE generation_tasks SET attempt_count=1,upstream_task_id='accepted' WHERE id=$1", task["id"]); err != nil { t.Fatal(err) }
	if _, err := a.DB.Exec(ctx, "ALTER TABLE generation_tasks DROP COLUMN upstream_submitted_at; DROP INDEX payment_orders_user_pending_idx; ALTER TABLE wallets ADD CONSTRAINT wallets_balance_micros_check CHECK(balance_micros>=0)"); err != nil { t.Fatal(err) }
	script, err := os.ReadFile("../../migrations/023_transaction_security.sql")
	if err != nil { t.Fatal(err) }
	if err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error { _, err := tx.Exec(ctx, string(script)); return err }); err != nil { t.Fatal(err) }
	testBalance(t, a, user, moneyScale, moneyScale)
	var protected bool
	if err := a.DB.QueryRow(ctx, "SELECT upstream_submitted_at IS NOT NULL FROM generation_tasks WHERE id=$1", task["id"]).Scan(&protected); err != nil || !protected { t.Fatalf("old in-flight task unprotected: %v", err) }
	var entries int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM wallet_entries WHERE user_id=$1", user).Scan(&entries); err != nil || entries != 1 { t.Fatalf("old ledger lost: %v", err) }
}
