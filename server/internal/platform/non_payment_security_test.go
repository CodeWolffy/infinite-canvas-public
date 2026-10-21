package platform

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pquerna/otp/totp"
	"github.com/redis/go-redis/v9"
)

func contentQuotaPool(t *testing.T, a *App, limit int64) {
	t.Helper()
	config := a.DB.Config()
	config.ConnConfig.RuntimeParams["ic.user_content_quota_bytes"] = fmt.Sprint(limit)
	db, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil { t.Fatal(err) }
	t.Cleanup(db.Close)
	a.DB = db
}

func assertContentUsage(t *testing.T, a *App, user string) int64 {
	t.Helper()
	var tracked, actual int64
	err := a.DB.QueryRow(context.Background(), `SELECT byte_size,coalesce((SELECT sum(bytes) FROM (
		SELECT octet_length(to_jsonb(p)::text)::bigint bytes FROM user_preferences p WHERE user_id=$1
		UNION ALL SELECT octet_length(to_jsonb(p)::text)::bigint FROM canvas_projects p WHERE user_id=$1
		UNION ALL SELECT octet_length(to_jsonb(p)::text)::bigint FROM canvas_project_history p WHERE user_id=$1
		UNION ALL SELECT octet_length(to_jsonb(p)::text)::bigint FROM assets p WHERE owner_id=$1
		UNION ALL SELECT octet_length(to_jsonb(p)::text)::bigint FROM canvas_templates p WHERE created_by=$1
	) content),0) FROM user_content_usage WHERE user_id=$1`, user).Scan(&tracked, &actual)
	if err != nil || tracked != actual { t.Fatalf("usage tracked=%d actual=%d: %v", tracked, actual, err) }
	return tracked
}

func TestContentQuotaConcurrentWritesAndNetReduction(t *testing.T) {
	a := testApp(t)
	contentQuotaPool(t, a, 1500)
	ctx := context.Background()
	user, _ := testUser(t, a, 0)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := a.DB.Exec(ctx, "INSERT INTO assets(owner_id,type,title,content) VALUES($1,'text','quota',$2)", user, strings.Repeat("x", 700))
			results <- err
		}()
	}
	wg.Wait(); close(results)
	succeeded, rejected := 0, 0
	for err := range results { if err == nil { succeeded++ } else if strings.Contains(err.Error(), "user_content_quota") { rejected++ } else { t.Fatal(err) } }
	if succeeded != 1 || rejected != 1 { t.Fatalf("quota bypass: success=%d rejected=%d", succeeded, rejected) }
	if assertContentUsage(t, a, user) > 1500 { t.Fatal("quota exceeded") }
	if _, err := a.DB.Exec(ctx, "DELETE FROM assets WHERE owner_id=$1", user); err != nil { t.Fatal(err) }
	if assertContentUsage(t, a, user) != 0 { t.Fatal("deletion did not release quota") }

	project := uuid.NewString()
	snapshot := Row{"nodes": []any{}, "connections": []any{}, "text": strings.Repeat("x", 600)}
	if _, err := a.DB.Exec(ctx, "INSERT INTO canvas_projects(id,user_id,title,snapshot) VALUES($1,$2,'canvas',$3)", project, user, jsonBytes(snapshot)); err != nil { t.Fatal(err) }
	// 中间值超过配额，净结果符合配额：历史备份与缩小快照必须可以原子提交。
	err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "INSERT INTO canvas_project_history(project_id,user_id,title,snapshot) SELECT id,user_id,title,snapshot FROM canvas_projects WHERE id=$1", project); err != nil { return err }
		_, err := tx.Exec(ctx, `UPDATE canvas_projects SET snapshot='{"nodes":[],"connections":[]}' WHERE id=$1`, project)
		return err
	})
	if err != nil { t.Fatal(err) }
	assertContentUsage(t, a, user)
	// 下调配额后，旧内容允许净缩小和删除，不能再增长。
	contentQuotaPool(t, a, 100)
	if _, err := a.DB.Exec(ctx, `UPDATE canvas_project_history SET snapshot='{}' WHERE project_id=$1`, project); err != nil { t.Fatal("old over-quota content could not shrink: ", err) }
	if _, err := a.DB.Exec(ctx, "UPDATE canvas_projects SET title=title||'more' WHERE id=$1", project); err == nil { t.Fatal("over-quota content grew") }
	if _, err := a.DB.Exec(ctx, "DELETE FROM canvas_projects WHERE id=$1", project); err != nil { t.Fatal(err) }
	if assertContentUsage(t, a, user) != 0 { t.Fatal("cascade delete did not release history quota") }
}

func TestContentQuotaRejectsPreferenceMergeAtomically(t *testing.T) {
	if os.Getenv("TEST_REDIS_ADDR") == "" { t.Skip("需要 TEST_REDIS_ADDR") }
	a := testApp(t)
	contentQuotaPool(t, a, 1500)
	user, cookie := testUser(t, a, 0)
	router := a.Router()
	if response := testRequest(router, "PUT", "/api/preferences", Row{"first": strings.Repeat("x", 900)}, cookie); response.Code != 200 { t.Fatal(response.Body.String()) }
	before := assertContentUsage(t, a, user)
	response := testRequest(router, "PUT", "/api/preferences", Row{"second": strings.Repeat("x", 900)}, cookie)
	if response.Code != 413 { t.Fatalf("quota response: %d %s", response.Code, response.Body.String()) }
	if assertContentUsage(t, a, user) != before { t.Fatal("rejected merge left partial data") }
	if response := testRequest(router, "PUT", "/api/preferences", Row{"first": "small"}, cookie); response.Code != 200 { t.Fatal(response.Body.String()) }
}

func TestContentQuotaMigrationBackfillsNonemptyDatabase(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" { t.Skip("需要 TEST_DATABASE_URL") }
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil { t.Fatal(err) }
	defer admin.Close()
	schema := pgx.Identifier{"quota_upgrade_" + strings.ReplaceAll(uuid.NewString(), "-", "")}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA " + schema); err != nil { t.Fatal(err) }
	defer admin.Exec(ctx, "DROP SCHEMA " + schema + " CASCADE")
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil { t.Fatal(err) }
	config.ConnConfig.RuntimeParams["search_path"] = schema
	config.ConnConfig.RuntimeParams["ic.user_content_quota_bytes"] = "100"
	db, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil { t.Fatal(err) }
	defer db.Close()
	scripts := loadMigrationScripts(t)
	for _, script := range scripts[:23] { if _, err := db.Exec(ctx, script); err != nil { t.Fatal(err) } }
	user := uuid.NewString()
	if _, err := db.Exec(ctx, "INSERT INTO users(id,username,password_hash,display_name) VALUES($1::uuid,$1::text,'unused','old')", user); err != nil { t.Fatal(err) }
	if _, err := db.Exec(ctx, "INSERT INTO user_preferences(user_id,preferences) VALUES($1,$2)", user, jsonBytes(Row{"old": strings.Repeat("x", 2000)})); err != nil { t.Fatal(err) }
	if _, err := db.Exec(ctx, scripts[23]); err != nil { t.Fatal("nonempty upgrade: ", err) }
	a := &App{DB: db}
	if assertContentUsage(t, a, user) < 2000 { t.Fatal("old content was not counted") }
	if _, err := db.Exec(ctx, "UPDATE user_preferences SET preferences='{}' WHERE user_id=$1", user); err != nil { t.Fatal("old user could not shrink after upgrade: ", err) }
	if _, err := db.Exec(ctx, "UPDATE user_preferences SET preferences=$2 WHERE user_id=$1", user, jsonBytes(Row{"new": "growth"})); err == nil { t.Fatal("over-quota old user could grow") }
}

func TestSharedMediaExcludesChatOnlyAttachments(t *testing.T) {
	if os.Getenv("TEST_REDIS_ADDR") == "" { t.Skip("需要 TEST_REDIS_ADDR") }
	a := testApp(t)
	ctx := context.Background()
	user, _ := testUser(t, a, 0)
	project, chatMedia, visibleMedia, token := uuid.NewString(), uuid.NewString(), uuid.NewString(), "share-"+uuid.NewString()
	for _, media := range []string{chatMedia, visibleMedia} {
		if _, err := a.DB.Exec(ctx, "INSERT INTO media_objects(id,owner_id,object_key,original_name,mime_type,byte_size,sha256) VALUES($1::uuid,$2,$1::text,'test.png','image/png',1,'fixture')", media, user); err != nil { t.Fatal(err) }
		if _, err := a.DB.Exec(ctx, "INSERT INTO media_references(owner_kind,owner_id,user_id,media_id) VALUES('canvas',$1,$2,$3)", project, user, media); err != nil { t.Fatal(err) }
	}
	snapshot := privateCanvasSnapshot(visibleMedia)
	snapshot["chatSessions"] = []any{Row{"messages": []any{Row{"attachments": []any{Row{"mediaId": chatMedia}}}}}}
	if _, err := a.DB.Exec(ctx, "INSERT INTO canvas_projects(id,user_id,title,snapshot) VALUES($1,$2,'private',$3)", project, user, jsonBytes(snapshot)); err != nil { t.Fatal(err) }
	if _, err := a.DB.Exec(ctx, "INSERT INTO share_links(user_id,kind,target_id,token) VALUES($1,'canvas',$2,$3)", user, project, token); err != nil { t.Fatal(err) }
	ids := extractMediaIDs(publicCanvasSnapshot(snapshot))
	if len(ids) != 1 || ids[0] != visibleMedia { t.Fatalf("wrong public media set: %v", ids) }
	router := a.Router()
	readMedia := func(id string) *httptest.ResponseRecorder {
		request := httptest.NewRequest("GET", "/api/shared/"+token+"/media/"+id, nil)
		request.Header.Set("If-None-Match", `"fixture"`)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}
	response := readMedia(chatMedia)
	if response.Code != 404 || !strings.Contains(response.Body.String(), "未被分享") { t.Fatalf("chat attachment authorized: %d %s", response.Code, response.Body.String()) }
	if response := readMedia(visibleMedia); response.Code != 304 { t.Fatalf("visible node media denied: %d %s", response.Code, response.Body.String()) }
	snapshot["nodes"] = []any{map[string]any{"mediaId": chatMedia}}
	if _, err := a.DB.Exec(ctx, "UPDATE canvas_projects SET snapshot=$2 WHERE id=$1", project, jsonBytes(snapshot)); err != nil { t.Fatal(err) }
	if response := readMedia(chatMedia); response.Code != 304 { t.Fatalf("media shared by both node and chat denied: %d %s", response.Code, response.Body.String()) }
	if _, err := a.DB.Exec(ctx, "UPDATE share_links SET revoked_at=now() WHERE token=$1", token); err != nil { t.Fatal(err) }
	response = readMedia(chatMedia)
	if response.Code != 404 || !strings.Contains(response.Body.String(), "share_not_found") { t.Fatalf("revoked share still usable: %d %s", response.Code, response.Body.String()) }
}

func TestSecurityProofFailureQuotaSharedAcrossInstances(t *testing.T) {
	if os.Getenv("TEST_REDIS_ADDR") == "" { t.Skip("需要 TEST_REDIS_ADDR") }
	a := testApp(t)
	user, _, password := testAdmin(t, a)
	ctx := context.Background()
	proofContext := func() *gin.Context {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("POST", "/admin/proof", nil)
		c.Request.RemoteAddr = "127.0.12.34:12345"
		c.Set("user", User{ID: user, Role: "admin"})
		return c
	}
	verify := func(app *App, proof securityProof) error { return pgx.BeginFunc(ctx, app.DB, func(tx pgx.Tx) error { return app.verifySecurityProof(proofContext(), tx, proof) }) }
	for range 8 { if err := verify(a, securityProof{Password: password}); err != nil { t.Fatal("success consumed quota: ", err) } }
	// 密码哈希损坏属于系统故障，不能记为用户输错。
	var encoded string
	if err := a.DB.QueryRow(ctx, "SELECT password_hash FROM users WHERE id=$1", user).Scan(&encoded); err != nil { t.Fatal(err) }
	if _, err := a.DB.Exec(ctx, "UPDATE users SET password_hash='broken' WHERE id=$1", user); err != nil { t.Fatal(err) }
	if err := verify(a, securityProof{Password: password}); err == nil { t.Fatal("broken hash accepted") }
	if count := a.Redis.ZCard(ctx, "ic:proof:user:"+user).Val(); count != 0 { t.Fatal("system failure consumed quota") }
	if _, err := a.DB.Exec(ctx, "UPDATE users SET password_hash=$2 WHERE id=$1", user, encoded); err != nil { t.Fatal(err) }
	other := &App{DB: a.DB, Redis: a.Redis, Config: a.Config}
	for i := 0; i < 5; i++ {
		var failure *apiError
		if err := verify(other, securityProof{Password: "wrong"}); !errors.As(err, &failure) || failure.Code != "invalid_password" { t.Fatalf("attempt %d: %v", i, err) }
	}
	var failure *apiError
	if err := verify(a, securityProof{Password: password}); !errors.As(err, &failure) || failure.Status != 429 { t.Fatalf("cross-instance quota bypass: %v", err) }
	withoutRedis := &App{DB: a.DB, Config: a.Config}
	if err := verify(withoutRedis, securityProof{Password: password}); !errors.As(err, &failure) || failure.Status != 503 { t.Fatalf("Redis failure did not fail closed: %v", err) }
	// 同一 MFA 验证码重用计为凭证错误。
	a.Redis.Del(ctx, "ic:proof:user:"+user, "ic:proof:ip:"+hash("127.0.12.34"))
	secret := "JBSWY3DPEHPK3PXP"
	sealed, err := a.seal(secret)
	if err != nil { t.Fatal(err) }
	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil { t.Fatal(err) }
	if _, err := a.DB.Exec(ctx, "UPDATE users SET encrypted_totp_secret=$2,totp_last_step=$3 WHERE id=$1", user, sealed, time.Now().Unix()/30); err != nil { t.Fatal(err) }
	if err := verify(a, securityProof{Password: password, Code: code}); !errors.As(err, &failure) || failure.Code != "invalid_mfa" { t.Fatalf("reused MFA accepted: %v", err) }
	if count := a.Redis.ZCard(ctx, "ic:proof:user:"+user).Val(); count != 1 { t.Fatalf("MFA failure count=%d", count) }
}

func TestSecurityProofIPReservationAndUnavailableRedis(t *testing.T) {
	if os.Getenv("TEST_REDIS_ADDR") == "" { t.Skip("需要 TEST_REDIS_ADDR") }
	a := testApp(t)
	makeContext := func() *gin.Context {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("POST", "/proof", nil)
		c.Request.RemoteAddr = "127.0.12.35:12345"
		c.Set("user", User{ID: uuid.NewString()})
		return c
	}
	refunds := []func(){}
	defer func() { for _, refund := range refunds { refund() } }()
	for range 30 {
		refund, err := a.securityProofQuota(makeContext())
		if err != nil { t.Fatal(err) }
		refunds = append(refunds, refund)
	}
	var failure *apiError
	if _, err := a.securityProofQuota(makeContext()); !errors.As(err, &failure) || failure.Status != 429 { t.Fatalf("IP quota bypass: %v", err) }
	refunds[0]()
	refund, err := a.securityProofQuota(makeContext())
	if err != nil { t.Fatal("refunded quota unavailable: ", err) }
	refunds = append(refunds, refund)
	unavailable := redis.NewClient(&redis.Options{Addr: "127.0.0.1:0", MaxRetries: -1})
	defer unavailable.Close()
	broken := &App{DB: a.DB, Config: a.Config, Redis: unavailable}
	if _, err := broken.securityProofQuota(makeContext()); !errors.As(err, &failure) || failure.Status != 503 { t.Fatalf("Redis outage did not fail closed: %v", err) }
}

func TestContentWriteRateLimitsRejectBeforeWriting(t *testing.T) {
	if os.Getenv("TEST_REDIS_ADDR") == "" { t.Skip("需要 TEST_REDIS_ADDR") }
	a := testApp(t)
	ctx := context.Background()
	user, cookie, _ := testAdmin(t, a)
	project := uuid.NewString()
	if _, err := a.DB.Exec(ctx, `INSERT INTO canvas_projects(id,user_id,title,snapshot) VALUES($1,$2,'rate','{"nodes":[],"connections":[]}')`, project, user); err != nil { t.Fatal(err) }
	router := a.Router()
	for _, item := range []struct { method, path, table string; payload Row; limit int }{
		{"PUT", "/api/preferences", "user_preferences", Row{"setting": "value"}, 60},
		{"POST", "/api/assets", "assets", Row{"type": "text", "title": "rate", "content": "value"}, 60},
		{"POST", "/api/canvas-projects/"+project+"/history", "canvas_project_history", Row{"note": "rate"}, 30},
		{"POST", "/api/admin/canvas-templates", "canvas_templates", Row{"title": "rate", "projectId": project}, 30},
	} {
		for i := 0; i < item.limit; i++ {
			if response := testRequest(router, item.method, item.path, item.payload, cookie); response.Code != 200 { t.Fatalf("%s attempt %d: %d %s", item.path, i, response.Code, response.Body.String()) }
		}
		var before, after int
		if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM "+item.table).Scan(&before); err != nil { t.Fatal(err) }
		response := testRequest(router, item.method, item.path, item.payload, cookie)
		if response.Code != 429 { t.Fatalf("%s allowed over quota: %d %s", item.path, response.Code, response.Body.String()) }
		if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM "+item.table).Scan(&after); err != nil || before != after { t.Fatalf("rate rejection wrote %s: %v", item.table, err) }
	}
}
