package platform

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestGenerationSearchFiltersBeforePagination(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, moneyScale)
	other, _ := testUser(t, a, 0)
	model, _ := capabilityModel(t, a, "image", "https://unused.invalid", 1)
	for i := range 55 {
		owner, prompt := user, fmt.Sprintf("其他图片 %d", i)
		if i < 2 {
			prompt = "较早的山水画 100%_风景"
		}
		if i == 54 {
			owner, prompt = other, "他人的山水画"
		}
		if _, err := a.DB.Exec(ctx, `INSERT INTO generation_batches(user_id,model_id,capability,prompt,requested_count,request_key,request_hash,created_at)
			VALUES($1,$2,'image',$3,1,$4,'fixture',$5)`, owner, model, prompt, uuid.NewString(), time.Now().Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	router := a.Router()
	for _, query := range []string{"q=%E5%B1%B1%E6%B0%B4&limit=1&offset=0", "q=%E5%B1%B1%E6%B0%B4&limit=1&offset=1", "q=100%25_&limit=50"} {
		response := testRequest(router, "GET", "/api/generation-batches?capability=image&"+query, nil, cookie)
		if response.Code != 200 {
			t.Fatal(response.Body.String())
		}
		items := responseRow(t, response)["batches"].([]any)
		if len(items) == 0 {
			t.Fatal("较早匹配记录未返回")
		}
		for _, item := range items {
			if object(item)["prompt"] != "较早的山水画 100%_风景" {
				t.Fatal("搜索结果越权或未过滤")
			}
		}
	}
	response := testRequest(router, "GET", "/api/generation-batches?capability=image&q=%E5%B1%B1%E6%B0%B4&limit=1&offset=2", nil, cookie)
	if len(responseRow(t, response)["batches"].([]any)) != 0 {
		t.Fatal("搜索分页遗漏权限过滤")
	}
}

func TestCancellationReturnsFinalStatusAndAuditsActualResult(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 2*moneyScale)
	admin, adminCookie, _ := testAdmin(t, a)
	model, _ := capabilityModel(t, a, "image", "https://unused.invalid", 100)
	router := a.Router()
	create := func() string {
		response := testRequest(router, "POST", "/api/generation-batches", Row{"requestId": uuid.NewString(), "modelId": model, "prompt": "test", "count": 1}, cookie)
		if response.Code != 200 {
			t.Fatal(response.Body.String())
		}
		return str(object(responseRow(t, response)["tasks"].([]any)[0])["id"])
	}
	id := create()
	first := testRequest(router, "POST", "/api/admin/tasks/"+id+"/cancel", nil, adminCookie)
	if first.Code != 200 {
		t.Fatal(first.Body.String())
	}
	if result := responseRow(t, first); result["canceled"] != true || result["status"] != "canceled" || result["refunded"] != "0.0001" {
		t.Fatal(result)
	}
	repeated := testRequest(router, "POST", "/api/admin/tasks/"+id+"/cancel", nil, adminCookie)
	if result := responseRow(t, repeated); result["canceled"] != false || result["status"] != "canceled" || result["refunded"] != "0" {
		t.Fatal(result)
	}
	testBalance(t, a, user, 2*moneyScale, 0)
	var actual, noOp int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FILTER(WHERE detail->>'canceled'='true'),count(*) FILTER(WHERE detail->>'canceled'='false') FROM audit_logs WHERE actor_id=$1 AND action='task.cancel' AND target=$2", admin, id).Scan(&actual, &noOp); err != nil || actual != 1 || noOp != 1 {
		t.Fatalf("audit %d/%d: %v", actual, noOp, err)
	}
	done := create()
	if err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		if _, err := changeWallet(ctx, tx, user, "charge", done+":1", 0, -100, "test settlement"); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, "UPDATE generation_tasks SET status='succeeded',billed_micros=100,finished_at=now() WHERE id=$1", done)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	completed := testRequest(router, "POST", "/api/generation-tasks/"+done+"/cancel", nil, cookie)
	if result := responseRow(t, completed); result["canceled"] != false || result["status"] != "succeeded" || result["refunded"] != "0" {
		t.Fatal(result)
	}
	_, stranger := testUser(t, a, 0)
	if response := testRequest(router, "POST", "/api/generation-tasks/"+done+"/cancel", nil, stranger); response.Code != http.StatusNotFound {
		t.Fatalf("cancel ownership: %d", response.Code)
	}
	rollback := create()
	if _, err := a.DB.Exec(ctx, "ALTER TABLE audit_logs ADD CONSTRAINT reject_cancel_audit CHECK (action<>'task.cancel') NOT VALID"); err != nil {
		t.Fatal(err)
	}
	failedAudit := testRequest(router, "POST", "/api/admin/tasks/"+rollback+"/cancel", nil, adminCookie)
	if failedAudit.Code != 500 {
		t.Fatal("审计失败必须阻止取消事务提交")
	}
	var status string
	if err := a.DB.QueryRow(ctx, "SELECT status FROM generation_tasks WHERE id=$1", rollback).Scan(&status); err != nil || status != "queued" {
		t.Fatalf("取消未回滚: %s %v", status, err)
	}
	testBalance(t, a, user, 2*moneyScale-200, 100)
}

func TestTaskBillingUsesLedgerAcrossRetriesAndChecksOwner(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 2*moneyScale)
	model, _ := capabilityModel(t, a, "image", "https://unused.invalid", 1000)
	router := a.Router()
	created := testRequest(router, "POST", "/api/generation-batches", Row{"requestId": uuid.NewString(), "modelId": model, "prompt": "test", "count": 1}, cookie)
	if created.Code != 200 {
		t.Fatal(created.Body.String())
	}
	id := str(object(responseRow(t, created)["tasks"].([]any)[0])["id"])
	read := func() Row {
		t.Helper()
		response := testRequest(router, "GET", "/api/generation-tasks/"+id+"/billing", nil, cookie)
		if response.Code != 200 {
			t.Fatal(response.Body.String())
		}
		return responseRow(t, response)
	}
	if current := object(read()["current"]); current["charged"] != nil || current["estimated"] != "0.001" || current["settled"] != false {
		t.Fatal(current)
	}
	if err := a.cancelTask(ctx, id, user, false); err != nil {
		t.Fatal(err)
	}
	if current := object(read()["current"]); current["charged"] != "0" || current["refunded"] != "0.001" || current["settled"] != true {
		t.Fatal(current)
	}
	for _, sample := range []struct {
		run     int
		charged int64
	}{{2, 250}, {3, 1500}} {
		if err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			reference := fmt.Sprintf("%s:%d", id, sample.run)
			if _, err := changeWallet(ctx, tx, user, "hold", reference, -1000, 1000, "test retry"); err != nil {
				return err
			}
			if _, err := changeWallet(ctx, tx, user, "charge", reference, 1000-sample.charged, -1000, "test settle"); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, "UPDATE generation_tasks SET status='succeeded',run=$2,billed_micros=$3,finished_at=now() WHERE id=$1", id, sample.run, sample.charged)
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	result := read()
	if result["totalCharged"] != "0.00175" {
		t.Fatal(result)
	}
	current := object(result["current"])
	if current["charged"] != "0.0015" || current["additional"] != "0.0005" || current["refunded"] != "0" {
		t.Fatal(current)
	}
	previous := object(result["attempts"].([]any)[1])
	if previous["charged"] != "0.00025" || previous["refunded"] != "0.00075" {
		t.Fatal(previous)
	}
	_, stranger := testUser(t, a, 0)
	if response := testRequest(router, "GET", "/api/generation-tasks/"+id+"/billing", nil, stranger); response.Code != http.StatusNotFound {
		t.Fatalf("billing ownership: %d", response.Code)
	}
}

func TestPaymentEntryFailureRetainsOrderAndResumesWithoutDuplicate(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 0)
	channel, _ := securityPaymentChannel(t, a, "https://payments.example.invalid")
	broken, _ := a.seal("invalid-json")
	if _, err := a.DB.Exec(ctx, "UPDATE payment_channels SET encrypted_config=$2 WHERE id=$1", channel, broken); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	input := Row{"channelId": channel, "method": "alipay", "amount": "1", "requestId": uuid.NewString()}
	failed := testRequest(router, "POST", "/api/user/payment-orders", input, cookie)
	if failed.Code != 200 {
		t.Fatal(failed.Body.String())
	}
	result := responseRow(t, failed)
	id := str(object(result["order"])["id"])
	if id == "" || result["paymentError"] == nil {
		t.Fatal("必须返回可恢复的原订单", result)
	}
	replay := testRequest(router, "POST", "/api/user/payment-orders", input, cookie)
	if str(object(responseRow(t, replay)["order"])["id"]) != id {
		t.Fatal("重复创建未保留原单")
	}
	sealed, _ := a.seal(string(jsonBytes(PaymentConfig{BaseURL: "https://payments.example.invalid", PartnerID: "merchant", Key: "test-only-secret"})))
	if _, err := a.DB.Exec(ctx, "UPDATE payment_orders SET encrypted_config=$2 WHERE id=$1", id, sealed); err != nil {
		t.Fatal(err)
	}
	resumed := testRequest(router, "POST", "/api/user/payment-orders/"+id+"/resume", nil, cookie)
	if resumed.Code != 200 || str(object(responseRow(t, resumed)["order"])["paymentUrl"]) == "" {
		t.Fatal(resumed.Body.String())
	}
	var count int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM payment_orders WHERE user_id=$1", user).Scan(&count); err != nil || count != 1 {
		t.Fatalf("order count=%d: %v", count, err)
	}
	_, stranger := testUser(t, a, 0)
	if response := testRequest(router, "POST", "/api/user/payment-orders/"+id+"/resume", nil, stranger); response.Code != http.StatusNotFound {
		t.Fatal("不应恢复他人订单")
	}
	if _, err := a.DB.Exec(ctx, "UPDATE payment_orders SET payment_url=NULL,expires_at=now()-interval '1 minute' WHERE id=$1", id); err != nil {
		t.Fatal(err)
	}
	expired := testRequest(router, "POST", "/api/user/payment-orders/"+id+"/resume", nil, cookie)
	if result := responseRow(t, expired); result["paymentError"] == nil || str(object(result["order"])["paymentUrl"]) != "" {
		t.Fatal(result)
	}
	testBalance(t, a, user, 0, 0)
}
