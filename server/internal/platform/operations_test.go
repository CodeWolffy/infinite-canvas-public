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
		{"insufficient_extra_becomes_debt", 1_200_000, 1_000_000, 500_000, 0, 3_000_000, 1_500_000},
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

func TestUserLogsScopeAndTotals(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 0)
	other, _ := testUser(t, a, 0)
	model, _ := capabilityModel(t, a, "text", "https://example.invalid", moneyScale)
	task := uuid.NewString()
	for _, query := range []struct {
		sql  string
		args []any
	}{
		{"INSERT INTO generation_tasks(id,user_id,model_id,capability,model_name,model_display_name,prompt,price_micros,status,prompt_tokens,cached_tokens,completion_tokens,finished_at) VALUES($1,$2,$3,'text','m','M','hi',0,'succeeded',120,30,456,now())", []any{task, user, model}},
		{"INSERT INTO request_logs(user_id,type,task_id,model_id,model_display_name_snapshot,channel_name_snapshot,upstream_model,status,billed_amount,first_token_ms,output_tokens,finished_at,duration_ms) VALUES($1,'text',$2,$3,'M','internal-channel','real-upstream','succeeded','0.012345',88,456,now(),900)", []any{user, task, model}},
		{"INSERT INTO request_logs(user_id,type,status,error_message,finished_at) VALUES($1,'image','failed','other user',now())", []any{other}},
	} {
		if _, err := a.DB.Exec(ctx, query.sql, query.args...); err != nil {
			t.Fatal(err)
		}
	}
	response := testRequest(a.Router(), "GET", "/api/user/logs", nil, cookie)
	body := responseRow(t, response)
	if response.Code != 200 {
		t.Fatalf("user logs: %d %s", response.Code, response.Body.String())
	}
	items, ok := body["logs"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("expected only own log: %s", response.Body.String())
	}
	entry := items[0].(map[string]any)
	if entry["promptTokens"] != float64(120) || entry["cachedTokens"] != float64(30) || entry["completionTokens"] != float64(456) || entry["outputTokens"] != float64(456) || entry["firstTokenMs"] != float64(88) {
		t.Fatalf("token fields: %v", entry)
	}
	if entry["billedAmount"] != "0.012345" {
		t.Fatalf("billed amount: %v", entry["billedAmount"])
	}
	for _, hidden := range []string{"channelId", "channelNameSnapshot", "upstreamModel", "keyId", "userId", "modelId", "username"} {
		if _, leaked := entry[hidden]; leaked {
			t.Fatalf("user log leaked %s", hidden)
		}
	}
	totals, ok := body["totals"].(map[string]any)
	if !ok || totals["total"] != float64(1) || totals["succeeded"] != float64(1) || totals["failed"] != float64(0) || totals["billedAmount"] != "0.012345" {
		t.Fatalf("totals: %v", body["totals"])
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
	_, cookie, password := testAdmin(t, a)
	response := testRequest(a.Router(), "POST", "/api/admin/models", map[string]any{"name": "video-test", "displayName": "video-test", "capability": "video", "status": "draft", "price": "0", "pricePerSecond": "0.15", "securityProof": securityProof{Password: password}}, cookie)
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
