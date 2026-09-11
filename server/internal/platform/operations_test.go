package platform

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestSettlementRegression(t *testing.T) {
	for _, sample := range []struct {
		name                                               string
		balance, hold, prompt, cached, cachePrice, charged int64
	}{
		{"extra_charge_once", 3_000_000, 1_000_000, 500_000, 0, 3_000_000, 1_500_000},
		{"insufficient_extra_matches_ledger", 1_200_000, 1_000_000, 500_000, 0, 3_000_000, 1_000_000},
		{"free_cached_tokens", 3_000_000, 1_000_000, 500_000, 500_000, 0, 0},
	} {
		t.Run(sample.name, func(t *testing.T) {
			a := testApp(t)
			ctx := context.Background()
			user, _ := testUser(t, a, sample.balance)
			model, conversation, taskID, worker := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			for _, query := range []struct {
				sql  string
				args []any
			}{
				{"INSERT INTO models(id,name,display_name,capability) VALUES($1,'regression','regression','text')", []any{model}},
				{"INSERT INTO conversations(id,user_id,title) VALUES($1,$2,'regression')", []any{conversation, user}},
				{"INSERT INTO generation_tasks(id,user_id,model_id,capability,model_name,model_display_name,prompt,price_micros,pricing_kind,input_price_per_million,cached_price_per_million,output_price_per_million,conversation_id,status,worker_token) VALUES($1,$2,$3,'text','regression','regression','hello',$4,'token',3000000,$5,0,$6,'running',$7)", []any{taskID, user, model, sample.hold, sample.cachePrice, conversation, worker}},
				{"INSERT INTO request_logs(user_id,type,task_id,status) VALUES($1,'text',$2,'running')", []any{user, taskID}},
			} {
				if _, err := a.DB.Exec(ctx, query.sql, query.args...); err != nil {
					t.Fatal(err)
				}
			}
			task, err := one(ctx, a.DB, "SELECT * FROM generation_tasks WHERE id=$1", taskID)
			if err != nil {
				t.Fatal(err)
			}
			if err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
				_, err := changeWallet(ctx, tx, user, "hold", taskReference(task), -sample.hold, sample.hold, "test")
				return err
			}); err != nil {
				t.Fatal(err)
			}
			result := &generationResult{Text: "done", PromptTokens: sample.prompt, CachedTokens: sample.cached}
			if err = a.finishTask(ctx, task, nil, result, nil); err != nil {
				t.Fatal(err)
			}
			testBalance(t, a, user, sample.balance-sample.charged, 0)
			stored, err := one(ctx, a.DB, "SELECT t.billed_micros,l.billed_amount FROM generation_tasks t JOIN request_logs l ON l.task_id=t.id WHERE t.id=$1", taskID)
			if err != nil {
				t.Fatal(err)
			}
			if integer(stored["billedMicros"]) != sample.charged {
				t.Fatalf("recorded charge %v, expected %d", stored["billedMicros"], sample.charged)
			}
			amount, err := amountUnits(str(stored["billedAmount"]), moneyScale)
			if err != nil || amount != sample.charged {
				t.Fatalf("log amount %v, expected %d: %v", stored["billedAmount"], sample.charged, err)
			}
			if err = a.finishTask(ctx, task, nil, result, nil); err != nil {
				t.Fatal(err)
			}
			testBalance(t, a, user, sample.balance-sample.charged, 0)
		})
	}
}

func TestRedeemDifferentCodesRegression(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 0)
	router := a.Router()
	for range 2 {
		code := uuid.NewString()
		if _, err := a.DB.Exec(ctx, "INSERT INTO redeem_codes(code_hash,code_hint,created_by,amount_micros,max_uses) VALUES($1,'test',$2,1000000,1)", hash(code), user); err != nil {
			t.Fatal(err)
		}
		response := testRequest(router, "POST", "/api/user/redeem", map[string]string{"code": code}, cookie)
		if response.Code != 200 {
			t.Fatalf("different code should redeem: %d %s", response.Code, response.Body.String())
		}
		response = testRequest(router, "POST", "/api/user/redeem", map[string]string{"code": code}, cookie)
		if response.Code != 400 {
			t.Fatalf("same code must not redeem twice: %d", response.Code)
		}
	}
	testBalance(t, a, user, 2_000_000, 0)
}

func TestPerSecondModelSaveRegression(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 0)
	if _, err := a.DB.Exec(ctx, "UPDATE users SET role='admin' WHERE id=$1", user); err != nil {
		t.Fatal(err)
	}
	response := testRequest(a.Router(), "POST", "/api/admin/models", map[string]any{"name": "video-test", "displayName": "video-test", "capability": "video", "status": "draft", "price": "0", "pricePerSecond": "0.15"}, cookie)
	if response.Code != 200 {
		t.Fatalf("create model: %d %s", response.Code, response.Body.String())
	}
	var payload struct {
		Model Row `json:"model"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	row, err := one(ctx, a.DB, "SELECT price_per_second FROM models WHERE id=$1", payload.Model["id"])
	if err != nil {
		t.Fatal(err)
	}
	if integer(row["pricePerSecond"]) != 150000 {
		t.Fatalf("price was not saved: %v", row["pricePerSecond"])
	}
}
