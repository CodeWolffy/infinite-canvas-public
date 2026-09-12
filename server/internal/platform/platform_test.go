package platform

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Calcium-Ion/go-epay/epay"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/redis/go-redis/v9"
)

func mustIP(address string) netip.Addr { return netip.MustParseAddr(address) }
func testApp(t *testing.T) *App {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("需要独立的 TEST_DATABASE_URL")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := "test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	db, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Close()
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+quoted+" CASCADE")
		admin.Close()
	})
	ddl, err := os.ReadFile("../../migrations/001_platform.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, string(ddl)); err != nil {
		t.Fatal(err)
	}
	for _, migration := range []string{"../../migrations/002_token_pricing.sql", "../../migrations/003_platform_features.sql", "../../migrations/004_platform_operations.sql", "../../migrations/005_platform_ops.sql", "../../migrations/006_storage_quota.sql", "../../migrations/007_monitor_cost_link.sql", "../../migrations/008_multi_upstream_models.sql", "../../migrations/009_soft_delete_channels.sql", "../../migrations/010_media_upload_state.sql", "../../migrations/011_probe_deadlines.sql", "../../migrations/012_channel_routing.sql", "../../migrations/013_moderation_and_rewards.sql", "../../migrations/014_channel_capability.sql"} {
		extra, err := os.ReadFile(migration)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(ctx, string(extra)); err != nil {
			t.Fatal(err)
		}
	}
	a := &App{DB: db, Config: Config{EncryptionKey: strings.Repeat("k", 32), CookieName: "test_session", SessionDays: 7, PublicURL: "http://localhost", Origins: []string{"http://localhost"}, MaxUpload: 50 * 1024 * 1024, MaxGenerated: 50 * 1024 * 1024, AllowPrivateHosts: true, TrustProxy: true, Bucket: strings.ReplaceAll(schema, "_", "-")}, startedAt: time.Now()}
	if addr := os.Getenv("TEST_REDIS_ADDR"); addr != "" {
		a.Redis = redis.NewClient(&redis.Options{Addr: addr})
		t.Cleanup(func() { _ = a.Redis.Close() })
	}
	if addr := os.Getenv("TEST_MINIO_ADDR"); addr != "" {
		a.S3, err = minio.New(addr, &minio.Options{Creds: credentials.NewStaticV4("canvas-test", "canvas-test-only", ""), Secure: false})
		if err != nil {
			t.Fatal(err)
		}
		if err = a.S3.MakeBucket(ctx, a.Config.Bucket, minio.MakeBucketOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	return a
}
func testUser(t *testing.T, a *App, balance int64) (string, *http.Cookie) {
	t.Helper()
	id := uuid.NewString()
	ctx := context.Background()
	if _, err := a.DB.Exec(ctx, "INSERT INTO users(id,username,password_hash,display_name) VALUES($1,$2,'unused','测试用户')", id, id); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO wallets(user_id,balance_micros) VALUES($1,$2)", id, balance); err != nil {
		t.Fatal(err)
	}
	token, err := a.session(ctx, a.DB, id)
	if err != nil {
		t.Fatal(err)
	}
	return id, &http.Cookie{Name: a.Config.CookieName, Value: token}
}
func testRequest(router http.Handler, method, path string, payload any, cookie *http.Cookie) *httptest.ResponseRecorder {
	body := bytes.NewReader(jsonBytes(payload))
	req := httptest.NewRequest(method, path, body)
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)
	return response
}
func testBalance(t *testing.T, a *App, userID string, want, held int64) {
	t.Helper()
	var balance, frozen int64
	if err := a.DB.QueryRow(context.Background(), "SELECT balance_micros,frozen_micros FROM wallets WHERE user_id=$1", userID).Scan(&balance, &frozen); err != nil {
		t.Fatal(err)
	}
	if balance != want || frozen != held {
		t.Fatalf("balance=%d frozen=%d, want %d/%d", balance, frozen, want, held)
	}
}

func TestMoneyExactness(t *testing.T) {
	for _, sample := range []struct {
		s           string
		scale, want int64
	}{{"0.000001", moneyScale, 1}, {"12.34", 100, 1234}, {"-1.2", moneyScale, -1200000}, {"0", moneyScale, 0}, {"9223372036854.775807", moneyScale, 9223372036854775807}} {
		got, err := amountUnits(sample.s, sample.scale)
		if err != nil || got != sample.want {
			t.Fatalf("%s: %d %v", sample.s, got, err)
		}
	}
	for _, bad := range []string{"0.0000001", "NaN", "9223372036854.775808"} {
		if _, err := amountUnits(bad, moneyScale); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	if _, err := amountUnits("1.001", 100); err == nil {
		t.Fatal("充值不能接受厘")
	}
}

func TestConcurrentPaymentCallbacksCreditOnce(t *testing.T) {
	a := testApp(t)
	id, _ := testUser(t, a, 0)
	ctx := context.Background()
	inviter, _ := testUser(t, a, 0)
	if _, err := a.DB.Exec(ctx, "INSERT INTO referrals(user_id,inviter_id) VALUES($1,$2)", id, inviter); err != nil {
		t.Fatal(err)
	}
	settings := defaultSettings
	settings.ReferralEnabled, settings.ReferralPercent = true, "12.5"
	if _, err := a.DB.Exec(ctx, "INSERT INTO app_settings(key,value) VALUES('platform',$1)", jsonBytes(settings)); err != nil {
		t.Fatal(err)
	}
	channelID, orderID := uuid.NewString(), uuid.NewString()
	config := PaymentConfig{BaseURL: "https://payments.example.com", PartnerID: "merchant-1", Key: "payment-test-secret"}
	sealed, err := a.seal(string(jsonBytes(config)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.Exec(ctx, "INSERT INTO payment_channels(id,name,provider,methods,encrypted_config) VALUES($1,'test','epay',ARRAY['alipay'],$2)", channelID, sealed); err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.Exec(ctx, "INSERT INTO payment_orders(id,user_id,channel_id,method,amount_cents,encrypted_config,provider,request_key,request_hash,expires_at) VALUES($1,$2,$3,'alipay',1234,$4,'epay',$5,'test',now()+interval '30 minutes')", orderID, id, channelID, sealed, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	params := map[string]string{"pid": config.PartnerID, "type": "alipay", "out_trade_no": merchantOrder(orderID), "trade_no": "trade-1", "money": "12.34", "trade_status": "TRADE_SUCCESS", "sign_type": "MD5"}
	params = epay.GenerateParams(params, config.Key)
	query := url.Values{}
	for key, value := range params {
		query.Set(key, value)
	}
	invalid := url.Values{}
	for key, values := range query {
		invalid[key] = append([]string{}, values...)
	}
	invalid.Set("money", "123.40")
	bad := testRequest(router, "GET", "/api/payments/notify/"+orderID+"?"+invalid.Encode(), nil, nil)
	if bad.Code == 200 {
		t.Fatal("accepted tampered payment")
	}
	testBalance(t, a, id, 0, 0)
	testBalance(t, a, inviter, 0, 0)
	var wg sync.WaitGroup
	failures := make(chan string, 24)
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			response := testRequest(router, "GET", "/api/payments/notify/"+orderID+"?"+query.Encode(), nil, nil)
			if response.Code != 200 {
				failures <- response.Body.String()
			}
		}()
	}
	wg.Wait()
	close(failures)
	for failure := range failures {
		t.Error(failure)
	}
	testBalance(t, a, id, 12340000, 0)
	testBalance(t, a, inviter, 1542500, 0)
	var count int
	if err = a.DB.QueryRow(ctx, "SELECT count(*) FROM wallet_entries WHERE user_id=$1", id).Scan(&count); err != nil || count != 1 {
		t.Fatalf("ledger count=%d err=%v", count, err)
	}
	if err = a.DB.QueryRow(ctx, "SELECT count(*) FROM wallet_entries WHERE user_id=$1 AND kind='referral' AND reference=$2", inviter, orderID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("referral ledger count=%d err=%v", count, err)
	}
	var reward int64
	if err = a.DB.QueryRow(ctx, "SELECT reward_micros FROM referrals WHERE user_id=$1", id).Scan(&reward); err != nil || reward != 1542500 {
		t.Fatalf("referral reward=%d err=%v", reward, err)
	}
	wrong := PaymentResult{Paid: true, TradeNo: "trade-1", MerchantOrder: merchantOrder(orderID), Method: "alipay", AmountCents: 1235}
	if a.creditPayment(ctx, orderID, wrong) == nil {
		t.Fatal("accepted mismatched amount on replay")
	}
}

func TestConcurrentCheckinUsesOneReward(t *testing.T) {
	a := testApp(t)
	id, cookie := testUser(t, a, 0)
	settings := defaultSettings
	settings.CheckinEnabled = true
	settings.RewardMin = "0.1"
	settings.RewardMax = "0.3"
	if _, err := a.DB.Exec(context.Background(), "INSERT INTO app_settings(key,value) VALUES('platform',$1)", jsonBytes(settings)); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	var wg sync.WaitGroup
	failures := make(chan int, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			response := testRequest(router, "POST", "/api/user/checkin", map[string]any{}, cookie)
			if response.Code != 200 {
				failures <- response.Code
			}
		}()
	}
	wg.Wait()
	close(failures)
	for code := range failures {
		t.Errorf("checkin status=%d", code)
	}
	var reward, count int64
	if err := a.DB.QueryRow(context.Background(), "SELECT reward_micros FROM checkins WHERE user_id=$1", id).Scan(&reward); err != nil {
		t.Fatal(err)
	}
	if reward < 100000 || reward > 300000 {
		t.Fatalf("reward=%d", reward)
	}
	testBalance(t, a, id, reward, 0)
	_ = a.DB.QueryRow(context.Background(), "SELECT count(*) FROM wallet_entries WHERE user_id=$1", id).Scan(&count)
	if count != 1 {
		t.Fatalf("ledger=%d", count)
	}
}

func TestGenerationIdempotencyAndSettlement(t *testing.T) {
	a := testApp(t)
	if a.Redis == nil || a.S3 == nil {
		t.Skip("需要 TEST_REDIS_ADDR 与 TEST_MINIO_ADDR")
	}
	id, cookie := testUser(t, a, 3*moneyScale)
	ctx := context.Background()
	var img bytes.Buffer
	if err := png.Encode(&img, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var input map[string]any
		_ = json.NewDecoder(r.Body).Decode(&input)
		if input["n"] != float64(1) {
			t.Error("generation count not enforced")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]string{"b64_json": base64.StdEncoding.EncodeToString(img.Bytes())}}})
	}))
	defer upstream.Close()
	modelID, channelID := uuid.NewString(), uuid.NewString()
	sealed, _ := a.seal("test-upstream-key")
	for _, query := range []struct {
		sql  string
		args []any
	}{{"INSERT INTO models(id,name,display_name,capability,status,price_micros) VALUES($1,'gpt-image-test','测试图片','image','published',1000000)", []any{modelID}}, {"INSERT INTO channels(id,name,capability,protocol,base_url,status) VALUES($1,'测试渠道','image','openai',$2,'active')", []any{channelID, upstream.URL}}, {"INSERT INTO channel_keys(channel_id,encrypted_api_key,key_hint) VALUES($1,$2,'已配置')", []any{channelID, sealed}}, {"INSERT INTO model_channels(model_id,channel_id,upstream_model) VALUES($1,$2,'gpt-image-test')", []any{modelID, channelID}}} {
		if _, err := a.DB.Exec(ctx, query.sql, query.args...); err != nil {
			t.Fatal(err)
		}
	}
	router := a.Router()
	input := map[string]any{"requestId": uuid.NewString(), "modelId": modelID, "prompt": "test", "count": 2, "parameters": map[string]any{"n": 100}}
	first := testRequest(router, "POST", "/api/generation-batches", input, cookie)
	if first.Code != 200 {
		t.Fatalf("create: %d %s", first.Code, first.Body.String())
	}
	replay := testRequest(router, "POST", "/api/generation-batches", input, cookie)
	if replay.Code != 200 {
		t.Fatal(replay.Body.String())
	}
	testBalance(t, a, id, moneyScale, 2*moneyScale)
	for i := 0; i < 2; i++ {
		task, err := one(ctx, a.DB, "UPDATE generation_tasks SET status='running',worker_token=$1,started_at=now(),deadline=now()+interval '480 seconds' WHERE id=(SELECT id FROM generation_tasks WHERE user_id=$2 AND status='queued' LIMIT 1) RETURNING *", uuid.NewString(), id)
		if err != nil {
			t.Fatal(err)
		}
		a.executeTask(ctx, task)
	}
	if calls.Load() != 2 {
		t.Fatalf("upstream calls=%d", calls.Load())
	}
	testBalance(t, a, id, moneyScale, 0)
	var succeeded int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM generation_tasks WHERE user_id=$1 AND status='succeeded'", id).Scan(&succeeded); err != nil || succeeded != 2 {
		details, _ := rows(ctx, a.DB, "SELECT status,error_code FROM generation_tasks WHERE user_id=$1", id)
		t.Fatalf("succeeded=%d error=%v details=%v", succeeded, err, details)
	}
	_, other := testUser(t, a, 0)
	var payload struct{ Batch struct{ ID string } }
	_ = json.Unmarshal(first.Body.Bytes(), &payload)
	denied := testRequest(router, "GET", "/api/generation-batches/"+payload.Batch.ID, nil, other)
	if denied.Code != 404 {
		t.Fatalf("other user status=%d", denied.Code)
	}
	mediaRows, _ := rows(ctx, a.DB, "SELECT output_media_id FROM generation_tasks WHERE user_id=$1", id)
	for _, m := range mediaRows {
		denied = testRequest(router, "GET", "/api/media/"+str(m["outputMediaId"]), nil, other)
		if denied.Code != 404 {
			t.Fatal("other user can read generated image")
		}
	}
}

func TestCancelAndLateSuccessCannotDoubleSettle(t *testing.T) {
	a := testApp(t)
	id, _ := testUser(t, a, 2*moneyScale)
	ctx := context.Background()
	model, taskID, token := uuid.NewString(), uuid.NewString(), uuid.NewString()
	_, err := a.DB.Exec(ctx, "INSERT INTO models(id,name,display_name,capability) VALUES($1,'test','test','image')", model)
	if err != nil {
		t.Fatal(err)
	}
	_, err = a.DB.Exec(ctx, "INSERT INTO generation_tasks(id,user_id,model_id,capability,model_name,model_display_name,prompt,price_micros,status,worker_token,deadline) VALUES($1,$2,$3,'image','test','test','test',1000000,'running',$4,now()+interval '480 seconds')", taskID, id, model, token)
	if err != nil {
		t.Fatal(err)
	}
	err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		_, err := changeWallet(ctx, tx, id, "hold", taskID+":1", -moneyScale, moneyScale, "test")
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	original, err := one(ctx, a.DB, "SELECT * FROM generation_tasks WHERE id=$1", taskID)
	if err != nil {
		t.Fatal(err)
	}
	if err = a.cancelTask(ctx, taskID, id, false); err != nil {
		t.Fatal(err)
	}
	if err = a.finishTask(ctx, original, nil, &generationResult{Text: "late"}, nil); err != nil {
		t.Fatal(err)
	}
	if err = a.cancelTask(ctx, taskID, id, false); err != nil {
		t.Fatal(err)
	}
	testBalance(t, a, id, 2*moneyScale, 0)
}

func TestSSRFAndCredentialRedirect(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "100.100.100.200", "::1", "::ffff:127.0.0.1"} {
		if publicIP(mustIP(address)) {
			t.Fatalf("accepted %s", address)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL, nil)
	if response, err := safeClient(false).Do(req); err == nil {
		response.Body.Close()
		t.Fatal("SSRF allowed")
	}
	first := httptest.NewRequest("GET", "https://upstream.example", nil)
	first.Header.Set("x-goog-api-key", "test-secret")
	next := httptest.NewRequest("GET", "https://other.example", nil)
	if err := safeClient(true).CheckRedirect(next, []*http.Request{first}); err != http.ErrUseLastResponse {
		t.Fatalf("redirect err=%v", err)
	}
}

func TestMediaReferenceOrder(t *testing.T) {
	a := testApp(t)
	id, _ := testUser(t, a, 0)
	ctx := context.Background()
	ids := []string{uuid.NewString(), uuid.NewString()}
	for i, mediaID := range ids {
		if _, err := a.DB.Exec(ctx, "INSERT INTO media_objects(id,owner_id,object_key,original_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,'ref.png','image/png',1,'hash')", mediaID, id, fmt.Sprint(i)); err != nil {
			t.Fatal(err)
		}
	}
	owner := uuid.NewString()
	err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		return syncMediaRefs(ctx, tx, "batch", owner, id, []string{ids[1], ids[0], ids[1]})
	})
	if err != nil {
		t.Fatal(err)
	}
	references, err := rows(ctx, a.DB, "SELECT media_id FROM media_references WHERE owner_id=$1 ORDER BY position", owner)
	if err != nil || len(references) != 2 || references[0]["mediaId"] != ids[1] || references[1]["mediaId"] != ids[0] {
		t.Fatalf("refs=%v err=%v", references, err)
	}
}

func TestTokenPricingSettlesByUsage(t *testing.T) {
	a := testApp(t)
	if a.Redis == nil || a.S3 == nil {
		t.Skip("需要 TEST_REDIS_ADDR 与 TEST_MINIO_ADDR")
	}
	id, cookie := testUser(t, a, moneyScale)
	ctx := context.Background()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]string{"role": "assistant", "content": "回复内容"}, "finish_reason": "stop"}},
			"usage":   map[string]any{"prompt_tokens": 500, "completion_tokens": 200},
		})
	}))
	defer upstream.Close()
	modelID, channelID := uuid.NewString(), uuid.NewString()
	sealed, _ := a.seal("test-upstream-key")
	// 输入 ¥2/百万token、缓存 ¥0.2/百万token、输出 ¥4/百万token；固定价 ¥0.01 仅作冻结下限。
	for _, query := range []struct {
		sql  string
		args []any
	}{{"INSERT INTO models(id,name,display_name,capability,status,price_micros,input_price_per_million,cached_price_per_million,output_price_per_million,config) VALUES($1,'gpt-test','测试文本','text','published',10000,2000000,200000,4000000,$2)", []any{modelID, jsonBytes(Row{"maxOutputTokens": 4096})}}, {"INSERT INTO channels(id,name,capability,protocol,base_url,status) VALUES($1,'测试渠道','text','openai',$2,'active')", []any{channelID, upstream.URL + "/v1"}}, {"INSERT INTO channel_keys(channel_id,encrypted_api_key,key_hint) VALUES($1,$2,'已配置')", []any{channelID, sealed}}, {"INSERT INTO model_channels(model_id,channel_id,upstream_model) VALUES($1,$2,'gpt-test')", []any{modelID, channelID}}} {
		if _, err := a.DB.Exec(ctx, query.sql, query.args...); err != nil {
			t.Fatal(err)
		}
	}
	router := a.Router()
	created := testRequest(router, "POST", "/api/text/requests", map[string]any{"requestId": uuid.NewString(), "modelId": modelID, "content": "你好", "title": "测试"}, cookie)
	if created.Code != 200 {
		t.Fatalf("create: %d %s", created.Code, created.Body.String())
	}
	task, err := one(ctx, a.DB, "UPDATE generation_tasks SET status='running',worker_token=$1,started_at=now(),deadline=now()+interval '480 seconds' WHERE id=(SELECT id FROM generation_tasks WHERE user_id=$2 AND capability='text' LIMIT 1) RETURNING *", uuid.NewString(), id)
	if err != nil {
		t.Fatal(err)
	}
	if str(task["pricingKind"]) != "token" || integer(task["priceMicros"]) <= 10000 {
		t.Fatalf("token 任务应按预估冻结高于固定价: pricing=%s frozen=%d", str(task["pricingKind"]), integer(task["priceMicros"]))
	}
	// 输入 500 中 300 命中缓存：(200×2 + 300×0.2 + 200×4)/1M = 1260 微元。
	if err = a.finishTask(ctx, task, nil, &generationResult{Text: "回复内容", PromptTokens: 500, CachedTokens: 300, CompletionTokens: 200}, nil); err != nil {
		t.Fatal(err)
	}
	testBalance(t, a, id, moneyScale-1260, 0)
	saved, err := one(ctx, a.DB, "SELECT prompt_tokens,cached_tokens,completion_tokens,billed_micros FROM generation_tasks WHERE id=$1", task["id"])
	if err != nil {
		t.Fatal(err)
	}
	if integer(saved["promptTokens"]) != 500 || integer(saved["cachedTokens"]) != 300 || integer(saved["completionTokens"]) != 200 || integer(saved["billedMicros"]) != 1260 {
		t.Fatalf("usage 落库不正确: %v", saved)
	}
}

func TestMigrationUpgradesV1ToV2(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("需要独立的 TEST_DATABASE_URL")
	}
	ctx := context.Background()
	database := "test_upgrade_" + strings.ReplaceAll(uuid.NewString(), "-", "_")
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+database); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(context.Background(), "DROP DATABASE "+database+" WITH (FORCE)") })
	base, query := dsn, ""
	if parts := strings.SplitN(dsn, "?", 2); len(parts) == 2 {
		base, query = parts[0], parts[1]
	}
	if slash := strings.LastIndex(base, "/"); slash >= 0 {
		base = base[:slash+1] + database
	}
	config, err := pgxpool.ParseConfig(base + "?" + query)
	if err != nil {
		t.Fatal(err)
	}
	db, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var migrations []string
	for _, migration := range []string{"../../migrations/001_platform.sql", "../../migrations/002_token_pricing.sql", "../../migrations/003_platform_features.sql", "../../migrations/004_platform_operations.sql"} {
		content, err := os.ReadFile(migration)
		if err != nil {
			t.Fatal(err)
		}
		migrations = append(migrations, string(content))
	}
	// 先建成 v2 状态的库，再验证运营、安全和流式消息结构按序升级。
	if _, err = db.Exec(ctx, migrations[0]); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, migrations[1]); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, "CREATE TABLE platform_schema(version integer PRIMARY KEY); INSERT INTO platform_schema VALUES (2)"); err != nil {
		t.Fatal(err)
	}
	app := &App{DB: db}
	if err = app.applyMigrations(ctx, migrations); err != nil {
		t.Fatal("升级失败: ", err)
	}
	var version int
	if err = db.QueryRow(ctx, "SELECT version FROM platform_schema").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != 4 {
		t.Fatalf("升级后版本应为 4，实际 %d", version)
	}
	var groupTables, taskColumns int
	if err = db.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('user_groups','redeem_codes','redeem_uses','sensitive_words')").Scan(&groupTables); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(ctx, "SELECT count(*) FROM information_schema.columns WHERE table_name='generation_tasks' AND column_name IN ('price_per_second','seconds','group_discount')").Scan(&taskColumns); err != nil {
		t.Fatal(err)
	}
	if groupTables != 4 || taskColumns != 3 {
		t.Fatalf("003 迁移不完整: tables=%d columns=%d", groupTables, taskColumns)
	}
}

func TestPlatformFeaturesRedeemGroupAndSensitive(t *testing.T) {
	a := testApp(t)
	if a.Redis == nil || a.S3 == nil {
		t.Skip("需要 TEST_REDIS_ADDR 与 TEST_MINIO_ADDR")
	}
	ctx := context.Background()
	// 兑换码:创建 → 兑换 → 重复兑换拒绝
	admin, _ := testUser(t, a, 0)
	if _, err := a.DB.Exec(ctx, "UPDATE users SET role='admin' WHERE id=$1", admin); err != nil {
		t.Fatal(err)
	}
	code := "CD-test-" + uuid.NewString()[:8]
	if _, err := a.DB.Exec(ctx, "INSERT INTO redeem_codes(code_hash,code_hint,created_by,note,amount_micros,max_uses) VALUES($1,'test…',$2,'测试',5000000,10)", hash(code), admin); err != nil {
		t.Fatal(err)
	}
	id, cookie := testUser(t, a, 0)
	router := a.Router()
	redeem := func(codeText string) int {
		response := testRequest(router, "POST", "/api/user/redeem", map[string]string{"code": codeText}, cookie)
		return response.Code
	}
	if status := redeem(code); status != 200 {
		t.Fatalf("首次兑换应成功: %d", status)
	}
	if status := redeem(code); status != 400 {
		t.Fatalf("重复兑换应拒绝: %d", status)
	}
	testBalance(t, a, id, 5*moneyScale, 0)

	// 用户分组:0.5 折扣用户提交生成时冻结减半
	groupID := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO user_groups(id,name,discount) VALUES($1,'半价组',0.5)", groupID); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "UPDATE users SET group_id=$2 WHERE id=$1", id, groupID); err != nil {
		t.Fatal(err)
	}
	var img bytes.Buffer
	if err := png.Encode(&img, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]string{"b64_json": base64.StdEncoding.EncodeToString(img.Bytes())}}})
	}))
	defer upstream.Close()
	modelID, channelID := uuid.NewString(), uuid.NewString()
	sealed, _ := a.seal("k")
	for _, query := range []struct {
		sql  string
		args []any
	}{{"INSERT INTO models(id,name,display_name,capability,status,price_micros) VALUES($1,'m','半价模型','image','published',2000000)", []any{modelID}}, {"INSERT INTO channels(id,name,capability,protocol,base_url,status) VALUES($1,'c','image','openai',$2,'active')", []any{channelID, upstream.URL}}, {"INSERT INTO channel_keys(channel_id,encrypted_api_key,key_hint) VALUES($1,$2,'已配置')", []any{channelID, sealed}}, {"INSERT INTO model_channels(model_id,channel_id,upstream_model) VALUES($1,$2,'m')", []any{modelID, channelID}}} {
		if _, err := a.DB.Exec(ctx, query.sql, query.args...); err != nil {
			t.Fatal(err)
		}
	}
	created := testRequest(router, "POST", "/api/generation-batches", map[string]any{"requestId": uuid.NewString(), "modelId": modelID, "prompt": "ok", "count": 1}, cookie)
	// 未带敏感词的请求应被接受,且冻结 = 2 元 × 0.5 = 1 元。
	if created.Code != 200 {
		t.Fatalf("分组用户生成提交失败: %d %s", created.Code, created.Body.String())
	}
	testBalance(t, a, id, 4*moneyScale, moneyScale)
	task, err := one(ctx, a.DB, "SELECT * FROM generation_tasks WHERE user_id=$1 ORDER BY queued_at DESC LIMIT 1", id)
	if err != nil {
		t.Fatal(err)
	}
	if integer(task["priceMicros"]) != moneyScale {
		t.Fatalf("分组折扣未生效: %d", integer(task["priceMicros"]))
	}

	// 敏感词:拦截生成提交
	if _, err := a.DB.Exec(ctx, "INSERT INTO sensitive_words(pattern,action) VALUES('forbidden-word','block')"); err != nil {
		t.Fatal(err)
	}
	blocked := testRequest(router, "POST", "/api/generation-batches", map[string]any{"requestId": uuid.NewString(), "modelId": modelID, "prompt": "包含 forbidden-word 的提示词", "count": 1}, cookie)
	if blocked.Code != 400 {
		t.Fatalf("敏感词应拦截: %d %s", blocked.Code, blocked.Body.String())
	}
}
