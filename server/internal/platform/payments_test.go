package platform

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/Calcium-Ion/go-epay/epay"
	"github.com/google/uuid"
)

// 生成一对测试 RSA 密钥，让支付宝/微信的验签失败确实发生在签名校验环节。
func testRSAKeyPair(t *testing.T) (string, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	privatePEM := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return privatePEM, string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

func testFormRequest(router http.Handler, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)
	return response
}

// 易支付：创建订单 → 回调验签 → 入账；重复与篡改的回调都不能重复入账。
func TestEpayOrderLifecycleCreditsOnce(t *testing.T) {
	a := testApp(t)
	if a.Redis == nil {
		t.Skip("需要 TEST_REDIS_ADDR")
	}
	userID, cookie := testUser(t, a, 0)
	ctx := context.Background()
	if _, err := a.DB.Exec(ctx, "INSERT INTO app_settings(key,value) VALUES('platform',$1)", jsonBytes(defaultSettings)); err != nil {
		t.Fatal(err)
	}
	config := PaymentConfig{BaseURL: "https://payments.example.com", PartnerID: "merchant-1", Key: "payment-test-secret"}
	sealed, err := a.seal(string(jsonBytes(config)))
	if err != nil {
		t.Fatal(err)
	}
	channelID := uuid.NewString()
	if _, err = a.DB.Exec(ctx, "INSERT INTO payment_channels(id,name,provider,methods,encrypted_config,enabled) VALUES($1,'易支付','epay',ARRAY['alipay'],$2,true)", channelID, sealed); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	created := testRequest(router, "POST", "/api/user/payment-orders", map[string]any{"channelId": channelID, "method": "alipay", "amount": "12.34", "requestId": uuid.NewString()}, cookie)
	if created.Code != 200 {
		t.Fatalf("创建订单失败: %d %s", created.Code, created.Body.String())
	}
	orderID := str(object(responseRow(t, created)["order"])["id"])
	if orderID == "" {
		t.Fatalf("订单响应缺少编号: %s", created.Body.String())
	}
	params := epay.GenerateParams(map[string]string{
		"pid": config.PartnerID, "type": "alipay", "out_trade_no": merchantOrder(orderID),
		"trade_no": "trade-epay-1", "money": "12.34", "trade_status": epay.StatusTradeSuccess, "sign_type": "MD5",
	}, config.Key)
	notify := func(mutate func(url.Values)) int {
		query := url.Values{}
		for key, value := range params {
			query.Set(key, value)
		}
		if mutate != nil {
			mutate(query)
		}
		return testRequest(router, "GET", "/api/payments/notify/"+orderID+"?"+query.Encode(), nil, nil).Code
	}
	// 金额被篡改：验签失败，不入账。
	if status := notify(func(query url.Values) { query.Set("money", "123.40") }); status == 200 {
		t.Fatal("篡改金额的通知被接受")
	}
	testBalance(t, a, userID, 0, 0)
	if status := notify(nil); status != 200 {
		t.Fatalf("合法通知应入账: %d", status)
	}
	testBalance(t, a, userID, 12340000, 0)
	// 重复通知：验签通过但订单已入账，余额不变。
	if status := notify(nil); status != 200 {
		t.Fatalf("重复通知应幂等返回 200: %d", status)
	}
	testBalance(t, a, userID, 12340000, 0)
	var entries int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM wallet_entries WHERE user_id=$1 AND kind='recharge'", userID).Scan(&entries); err != nil || entries != 1 {
		t.Fatalf("入账记录应为 1 条: %d %v", entries, err)
	}
}

// 支付宝与微信的通知必须验签：签名缺失或错误一律拒绝，且不产生入账。
func TestPaymentNotificationsRejectInvalidSignature(t *testing.T) {
	privateKey, publicKey := testRSAKeyPair(t)
	for _, provider := range []string{"alipay", "wechat"} {
		t.Run(provider, func(t *testing.T) {
			a := testApp(t)
			userID, _ := testUser(t, a, 0)
			ctx := context.Background()
			config := PaymentConfig{BaseURL: "https://payments.example.com", PartnerID: "merchant-1", Key: "payment-test-secret", AppID: "app-1", SellerID: "seller-1", MchID: "mch-1", SerialNo: "serial-1", PublicKeyID: "key-1", APIV3Key: "0123456789abcdef0123456789abcdef", PrivateKey: privateKey, PublicKey: publicKey}
			sealed, err := a.seal(string(jsonBytes(config)))
			if err != nil {
				t.Fatal(err)
			}
			channelID, orderID := uuid.NewString(), uuid.NewString()
			if _, err = a.DB.Exec(ctx, "INSERT INTO payment_channels(id,name,provider,methods,encrypted_config,enabled) VALUES($1,$2,$3,ARRAY['alipay'],$4,true)", channelID, provider, provider, sealed); err != nil {
				t.Fatal(err)
			}
			if _, err = a.DB.Exec(ctx, "INSERT INTO payment_orders(id,user_id,channel_id,method,amount_cents,encrypted_config,provider,request_key,request_hash,expires_at) VALUES($1,$2,$3,'alipay',1234,$4,$5,$6,'test',now()+interval '30 minutes')", orderID, userID, channelID, sealed, provider, uuid.NewString()); err != nil {
				t.Fatal(err)
			}
			form := url.Values{}
			form.Set("out_trade_no", merchantOrder(orderID))
			form.Set("trade_no", "trade-1")
			form.Set("total_amount", "12.34")
			form.Set("trade_status", "TRADE_SUCCESS")
			form.Set("sign", "not-a-valid-signature")
			form.Set("sign_type", "RSA2")
			response := testFormRequest(a.Router(), "POST", "/api/payments/notify/"+orderID, form.Encode())
			if response.Code == 200 {
				t.Fatalf("%s 接受了无效签名的通知: %s", provider, response.Body.String())
			}
			testBalance(t, a, userID, 0, 0)
			var paid int
			if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM payment_orders WHERE id=$1 AND status='paid'", orderID).Scan(&paid); err != nil || paid != 0 {
				t.Fatalf("无效通知不应把订单标记为已支付: %d %v", paid, err)
			}
		})
	}
}
