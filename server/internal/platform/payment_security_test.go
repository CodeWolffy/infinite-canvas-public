package platform

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Calcium-Ion/go-epay/epay"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func securityPaymentChannel(t *testing.T, a *App, endpoint string) (string, string) {
	t.Helper()
	sealed, err := a.seal(string(jsonBytes(PaymentConfig{BaseURL: endpoint, PartnerID: "security-merchant", Key: "security-payment-key"})))
	if err != nil { t.Fatal(err) }
	id := uuid.NewString()
	if _, err := a.DB.Exec(context.Background(), "INSERT INTO payment_channels(id,name,provider,methods,encrypted_config,enabled) VALUES($1,'security','epay',ARRAY['alipay'],$2,true)", id, sealed); err != nil { t.Fatal(err) }
	return id, sealed
}

func TestEpayTransportErrorOmitsMerchantKey(t *testing.T) {
	failure := errors.New("connection refused")
	previous := publicClient
	publicClient = &http.Client{Transport: &http.Transport{DialContext: func(context.Context, string, string) (net.Conn, error) {
		return nil, failure
	}}}
	defer func() { publicClient = previous }()
	config := PaymentConfig{BaseURL: "https://payments.example.invalid", PartnerID: "merchant", Key: "secret-with+/%&symbols"}
	_, err := (&App{}).queryPayment(context.Background(), Row{"id": uuid.NewString(), "provider": "epay", "method": "alipay"}, config)
	if !errors.Is(err, failure) {
		t.Fatalf("应保留网络错误原因: %v", err)
	}
	for _, secret := range []string{config.Key, url.QueryEscape(config.Key), "key="} {
		if strings.Contains(err.Error(), secret) {
			t.Fatal("查单错误包含商户密钥或敏感 URL")
		}
	}
}

func TestExpiredPaymentRemainsReconcilableAndCreditsOnce(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 0)
	var paid atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !paid.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(Row{"code": 1, "pid": "security-merchant", "type": "alipay", "out_trade_no": r.URL.Query().Get("out_trade_no"), "trade_no": "recovered-trade", "money": "1.00", "status": 1})
	}))
	defer upstream.Close()
	previous := publicClient
	publicClient = upstream.Client()
	defer func() { publicClient = previous }()
	channel, config := securityPaymentChannel(t, a, upstream.URL)
	order, err := one(ctx, a.DB, "INSERT INTO payment_orders(user_id,channel_id,method,amount_cents,encrypted_config,provider,request_key,request_hash,expires_at) VALUES($1,$2,'alipay',100,$3,'epay',$4,'expired',now()-interval '1 hour') RETURNING *", user, channel, config, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	a.reconcileExpiredOrders(ctx)
	var status string
	if err := a.DB.QueryRow(ctx, "SELECT status FROM payment_orders WHERE id=$1", order["id"]).Scan(&status); err != nil || status != "pending" {
		t.Fatalf("查单失败后应保留自动对账: %s %v", status, err)
	}
	for range 9 {
		if _, err := a.DB.Exec(ctx, "INSERT INTO payment_orders(user_id,channel_id,method,amount_cents,encrypted_config,provider,request_key,request_hash,expires_at) VALUES($1,$2,'alipay',100,$3,'epay',$4,'active',now()+interval '30 minutes')", user, channel, config, uuid.NewString()); err != nil {
			t.Fatal(err)
		}
	}
	response := testRequest(a.Router(), "POST", "/api/user/payment-orders", Row{"channelId": channel, "method": "alipay", "amount": "1", "requestId": uuid.NewString()}, cookie)
	if response.Code != 200 {
		t.Fatalf("过期订单不应占有效待支付额度: %d %s", response.Code, response.Body.String())
	}
	paid.Store(true)
	a.reconcileExpiredOrders(ctx)
	if err := a.DB.QueryRow(ctx, "SELECT status FROM payment_orders WHERE id=$1", order["id"]).Scan(&status); err != nil || status != "paid" {
		t.Fatalf("网关恢复后应自动补到账: %s %v", status, err)
	}
	if err := a.reconcilePayment(ctx, order); err != nil {
		t.Fatal(err)
	}
	testBalance(t, a, user, moneyScale, 0)
}

func TestPaymentAccountAndIPRateBoundaries(t *testing.T) {
	a := routingApp(t)
	for _, sample := range []struct { purpose string; account, ip int }{{"create", 10, 60}, {"query", 60, 120}} {
		for _, scope := range []string{"account", "ip"} {
			purpose := "security-" + sample.purpose + uuid.NewString()
			user, ip := uuid.NewString(), "203.0.113.224"
			limit := sample.account
			if scope == "ip" { limit = sample.ip }
			for i := 0; i <= limit; i++ {
				c, _ := gin.CreateTestContext(httptest.NewRecorder())
				c.Request = httptest.NewRequest("POST", "/payment-test", nil)
				c.Request.RemoteAddr = ip + ":12345"
				if scope == "ip" { user = uuid.NewString() }
				c.Set("user", User{ID: user})
				err := a.paymentRate(c, purpose, sample.account, sample.ip)
				if i < limit && err != nil { t.Fatalf("early %s %s limit: %v", sample.purpose, scope, err) }
				if i == limit {
					var api *apiError
					if !errors.As(err, &api) || api.Status != 429 || c.Writer.Header().Get("Retry-After") == "" { t.Fatalf("missing %s %s limit: %v", sample.purpose, scope, err) }
				}
			}
		}
	}
}

func TestPendingPaymentLimitIsAtomicAndIdempotent(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 0)
	channel, config := securityPaymentChannel(t, a, "https://payments.example.invalid")
	for range 9 {
		if _, err := a.DB.Exec(ctx, "INSERT INTO payment_orders(user_id,channel_id,method,amount_cents,encrypted_config,provider,request_key,request_hash,expires_at) VALUES($1,$2,'alipay',100,$3,'epay',$4,'seed',now()+interval '30 minutes')", user, channel, config, uuid.NewString()); err != nil { t.Fatal(err) }
	}
	router := a.Router()
	input := []Row{
		{"channelId": channel, "method": "alipay", "amount": "1", "requestId": uuid.NewString()},
		{"channelId": channel, "method": "alipay", "amount": "1", "requestId": uuid.NewString()},
	}
	responses := make([]*httptest.ResponseRecorder, 2)
	var wg sync.WaitGroup
	for i := range input {
		wg.Add(1)
		go func(i int) { defer wg.Done(); responses[i] = testRequest(router, "POST", "/api/user/payment-orders", input[i], cookie) }(i)
	}
	wg.Wait()
	success := -1
	for i, response := range responses {
		if response.Code == 200 { success = i } else if response.Code != 429 { t.Fatalf("unexpected create result: %d %s", response.Code, response.Body.String()) }
	}
	var pending int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM payment_orders WHERE user_id=$1 AND status='pending'", user).Scan(&pending); err != nil || pending != 10 || success == -1 { t.Fatalf("pending=%d success=%d: %v", pending, success, err) }
	if response := testRequest(router, "POST", "/api/user/payment-orders", input[success], cookie); response.Code != 200 { t.Fatal("pending cap blocked an idempotent request") }
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM payment_orders WHERE user_id=$1", user).Scan(&pending); err != nil || pending != 10 { t.Fatal("replay created another payment order") }
}

func TestPaymentQueryIsMergedAcrossInstancesAndCallbackStillCredits(t *testing.T) {
	a := routingApp(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	user, cookie := testUser(t, a, 0)
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	var startedOnce, releaseOnce sync.Once
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		startedOnce.Do(func() { close(started) })
		select { case <-release: case <-r.Context().Done(): return }
		_ = json.NewEncoder(w).Encode(Row{"code": 1, "pid": "security-merchant", "type": "alipay", "out_trade_no": r.URL.Query().Get("out_trade_no"), "trade_no": "security-trade", "money": "1.00", "status": 1})
	}))
	defer upstream.Close()
	defer releaseOnce.Do(func() { close(release) })
	// 仅此隔离测试把支付客户端指向本地假网关，不访问真实商户。
	previous := publicClient
	publicClient = upstream.Client()
	defer func() { publicClient = previous }()
	channel, _ := securityPaymentChannel(t, a, upstream.URL)
	router := a.Router()
	created := testRequest(router, "POST", "/api/user/payment-orders", Row{"channelId": channel, "method": "alipay", "amount": "1", "requestId": uuid.NewString()}, cookie)
	if created.Code != 200 { t.Fatal(created.Body.String()) }
	id := str(object(responseRow(t, created)["order"])["id"])
	order, err := one(ctx, a.DB, "SELECT * FROM payment_orders WHERE id=$1", id)
	if err != nil { t.Fatal(err) }
	done := make(chan error, 1)
	go func() { done <- a.reconcilePayment(ctx, order) }()
	select { case <-started: case <-ctx.Done(): t.Fatal("query did not start") }
	otherInstance := &App{DB: a.DB, Config: a.Config}
	for range 8 {
		if err := otherInstance.reconcilePayment(ctx, order); err != nil { t.Fatal(err) }
	}
	if calls.Load() != 1 { t.Fatalf("duplicate gateway queries: %d", calls.Load()) }
	params := epay.GenerateParams(map[string]string{"pid": "security-merchant", "type": "alipay", "out_trade_no": merchantOrder(id), "trade_no": "security-trade", "money": "1.00", "trade_status": epay.StatusTradeSuccess, "sign_type": "MD5"}, "security-payment-key")
	query := url.Values{}
	for key, value := range params { query.Set(key, value) }
	if response := testRequest(router, "GET", "/api/payments/notify/"+id+"?"+query.Encode(), nil, nil); response.Code != 200 { t.Fatal(response.Body.String()) }
	testBalance(t, a, user, moneyScale, 0)
	releaseOnce.Do(func() { close(release) })
	if err := <-done; err != nil { t.Fatal(err) }
	if err := a.reconcilePayment(ctx, order); err != nil { t.Fatal(err) }
	if calls.Load() != 1 { t.Fatal("paid order queried again") }
	testBalance(t, a, user, moneyScale, 0)
}
