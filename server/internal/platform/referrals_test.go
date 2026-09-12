package platform

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestReferralUsesPaidAmountAndCurrentRateAtomically(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	inviter, _ := testUser(t, a, 0)
	friend, cookie := testUser(t, a, 0)
	if _, err := a.DB.Exec(ctx, "INSERT INTO referrals(user_id,inviter_id) VALUES($1,$2)", friend, inviter); err != nil {
		t.Fatal(err)
	}
	channel := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO payment_channels(id,name,provider,methods,encrypted_config) VALUES($1,'test','epay',ARRAY['alipay'],'unused')", channel); err != nil {
		t.Fatal(err)
	}
	newPayment := func(cents int64) (string, PaymentResult) {
		id := uuid.NewString()
		if _, err := a.DB.Exec(ctx, "INSERT INTO payment_orders(id,user_id,channel_id,method,amount_cents,encrypted_config,provider,request_key,request_hash,expires_at) VALUES($1,$2,$3,'alipay',$4,'unused','epay',$5,'test',now()+interval '30 minutes')", id, friend, channel, cents, uuid.NewString()); err != nil {
			t.Fatal(err)
		}
		return id, PaymentResult{Paid: true, TradeNo: "trade-" + id, MerchantOrder: merchantOrder(id), Method: "alipay", AmountCents: cents}
	}
	settings := defaultSettings
	settings.CheckinEnabled, settings.RewardMin, settings.RewardMax = true, "1", "1"
	saveSettings := func(enabled bool, percent string) {
		settings.ReferralEnabled, settings.ReferralPercent = enabled, percent
		if _, err := a.DB.Exec(ctx, "INSERT INTO app_settings(key,value) VALUES('platform',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", jsonBytes(settings)); err != nil {
			t.Fatal(err)
		}
	}
	var earned, paid int64
	payments := map[string]PaymentResult{}
	for _, sample := range []struct {
		enabled bool
		percent string
		cents   int64
		reward  int64
	}{{true, "12.5", 1234, 1542500}, {true, "7.25", 10000, 7250000}, {false, "25", 10000, 0}, {true, "0", 10000, 0}, {true, "0.015", 1, 1}} {
		id, result := newPayment(sample.cents)
		// 创建订单后修改比例，必须采用实际入账时的配置。
		saveSettings(sample.enabled, sample.percent)
		if err := a.creditPayment(ctx, id, result); err != nil {
			t.Fatal(err)
		}
		payments[id] = result
		earned += sample.reward
		paid += sample.cents * 10000
		testBalance(t, a, inviter, earned, 0)
		testBalance(t, a, friend, paid, 0)
	}
	saveSettings(true, "50")
	for id, result := range payments {
		if err := a.creditPayment(ctx, id, result); err != nil {
			t.Fatal(err)
		}
	}
	testBalance(t, a, inviter, earned, 0)
	code := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO redeem_codes(code_hash,code_hint,created_by,amount_micros,max_uses) VALUES($1,'test',$2,1000000,1)", hash(code), inviter); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	for path, payload := range map[string]Row{"/api/user/redeem": {"code": code}, "/api/user/checkin": {}} {
		if response := testRequest(router, "POST", path, payload, cookie); response.Code != 200 {
			t.Fatalf("%s: %d %s", path, response.Code, response.Body.String())
		}
	}
	paid += 2 * moneyScale
	testBalance(t, a, inviter, earned, 0)
	testBalance(t, a, friend, paid, 0)
	var credits int
	var recorded int64
	if err := a.DB.QueryRow(ctx, "SELECT reward_micros,(SELECT count(*) FROM wallet_entries WHERE user_id=$2 AND kind='referral') FROM referrals WHERE user_id=$1", friend, inviter).Scan(&recorded, &credits); err != nil || recorded != earned || credits != 3 {
		t.Fatalf("recorded=%d credits=%d error=%v", recorded, credits, err)
	}
	// 模拟返利钱包写入失败，好友充值、支付状态和两份账本都必须回滚。
	if _, err := a.DB.Exec(ctx, "UPDATE wallets SET balance_micros=$2 WHERE user_id=$1", inviter, int64(1<<63-1)); err != nil {
		t.Fatal(err)
	}
	id, result := newPayment(200)
	if err := a.creditPayment(ctx, id, result); err == nil {
		t.Fatal("expected referral wallet overflow")
	}
	testBalance(t, a, friend, paid, 0)
	var status string
	if err := a.DB.QueryRow(ctx, "SELECT status FROM payment_orders WHERE id=$1", id).Scan(&status); err != nil || status != "pending" {
		t.Fatalf("status=%s error=%v", status, err)
	}
	if _, err := a.DB.Exec(ctx, "UPDATE wallets SET balance_micros=$2 WHERE user_id=$1", inviter, earned); err != nil {
		t.Fatal(err)
	}
	if err := a.creditPayment(ctx, id, result); err != nil {
		t.Fatal(err)
	}
	testBalance(t, a, inviter, earned+moneyScale, 0)
	testBalance(t, a, friend, paid+2*moneyScale, 0)
}
