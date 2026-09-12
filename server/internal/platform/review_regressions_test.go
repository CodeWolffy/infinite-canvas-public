package platform

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

func reviewPNG(t *testing.T) []byte {
	t.Helper()
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func TestCostReportUsesPositiveUserPayment(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, moneyScale)
	model, channel := capabilityModel(t, a, "image", "https://example.com", moneyScale)
	task := uuid.NewString()
	for _, query := range []struct {
		sql  string
		args []any
	}{
		{"UPDATE users SET role='admin' WHERE id=$1", []any{user}},
		{"INSERT INTO generation_tasks(id,user_id,model_id,channel_id,capability,model_name,model_display_name,prompt,price_micros,billed_micros,status,finished_at) VALUES($1,$2,$3,$4,'image','test','test','test',600000,600000,'succeeded',now())", []any{task, user, model, channel}},
		{"INSERT INTO upstream_cost_entries(id,task_id,user_id,model_id,channel_id,capability,amount_micros,source,status) VALUES($1,$2,$3,$4,$5,'image',1000000,'configured','succeeded')", []any{uuid.NewString(), task, user, model, channel}},
	} {
		if _, err := a.DB.Exec(ctx, query.sql, query.args...); err != nil {
			t.Fatal(err)
		}
	}
	response := testRequest(a.Router(), "GET", "/api/admin/costs?modelId="+model, nil, cookie)
	totals := object(responseRow(t, response)["totals"])
	if response.Code != 200 || totals["userPaid"] != "0.600000" || totals["subsidy"] != "0.400000" {
		t.Fatalf("cost report: %d %s", response.Code, response.Body.String())
	}
}

func TestCanceledUploadRemovesReservation(t *testing.T) {
	a := testApp(t)
	user, _ := testUser(t, a, 0)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		cancel()
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer storage.Close()
	var err error
	a.S3, err = minio.New(strings.TrimPrefix(storage.URL, "http://"), &minio.Options{Creds: credentials.NewStaticV4("test", "test", ""), Region: "us-east-1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.storeMedia(ctx, user, reviewPNG(t), "canceled.png"); err == nil {
		t.Fatal("expected interrupted upload")
	}
	var count int
	if err = a.DB.QueryRow(context.Background(), "SELECT count(*) FROM media_objects WHERE owner_id=$1", user).Scan(&count); err != nil || count != 0 {
		t.Fatalf("upload left %d reservations: %v", count, err)
	}
}

func TestPlaygroundReturnsUpstreamResultsAndRecordsCost(t *testing.T) {
	a := testApp(t)
	if a.Redis == nil {
		t.Skip("需要 TEST_REDIS_ADDR")
	}
	ctx := context.Background()
	user, cookie := testUser(t, a, moneyScale)
	if _, err := a.DB.Exec(ctx, "UPDATE users SET role='admin' WHERE id=$1", user); err != nil {
		t.Fatal(err)
	}
	encoded := base64.StdEncoding.EncodeToString(reviewPNG(t))
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/images/generations") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			fmt.Fprintf(w, `{"data":[{"b64_json":"%s"}],"marker":"native-image","debug":"test-key"}`, encoded)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}],\"debug\":\"test-key\"}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	for _, capability := range []string{"text", "image"} {
		model, channel := capabilityModel(t, a, capability, upstream.URL, 0)
		if _, err := a.DB.Exec(ctx, "UPDATE model_channels SET cost_config=$3 WHERE model_id=$1 AND channel_id=$2", model, channel, jsonBytes(Row{"fixed": "0.1"})); err != nil {
			t.Fatal(err)
		}
		response := testRequest(a.Router(), "POST", "/api/admin/playground/test", Row{"channelId": channel, "model": "test", "capability": capability, "prompt": "hello"}, cookie)
		result := responseRow(t, response)
		if response.Code != 200 || result["ok"] != true || result["rawResponse"] == nil || strings.Contains(response.Body.String(), "test-key") {
			t.Fatalf("playground: %d %s", response.Code, response.Body.String())
		}
		if capability == "text" && (result["text"] != "OK" || result["firstTokenMs"] == nil || integer(result["httpStatus"]) != 200) {
			t.Fatalf("missing text metrics: %v", result)
		}
		if capability == "image" && (!strings.HasPrefix(str(result["image"]), "data:image/png;base64,") || integer(result["httpStatus"]) != 201 || object(result["rawResponse"])["marker"] != "native-image") {
			t.Fatalf("missing image response: %v", result)
		}
		var amount int64
		if err := a.DB.QueryRow(ctx, "SELECT amount_micros FROM upstream_cost_entries WHERE channel_id=$1 AND status='succeeded' AND source='configured'", channel).Scan(&amount); err != nil || amount != 100000 {
			t.Fatalf("missing probe cost: %d %v", amount, err)
		}
		if count, err := a.Redis.ZCard(ctx, "ic:slots:"+channel).Result(); err != nil || count != 0 {
			t.Fatalf("probe retained channel slot: %d %v", count, err)
		}
	}
	testBalance(t, a, user, moneyScale, 0)
	var tasks int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM generation_tasks WHERE user_id=$1", user).Scan(&tasks); err != nil || tasks != 0 {
		t.Fatalf("playground created %d formal tasks: %v", tasks, err)
	}
	stale := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO upstream_cost_entries(id,channel_id,capability,deadline) SELECT $1,channel_id,capability,now()-interval '1 second' FROM upstream_cost_entries LIMIT 1", stale); err != nil {
		t.Fatal(err)
	}
	a.recoverTasks(ctx)
	entry, err := one(ctx, a.DB, "SELECT status,source FROM upstream_cost_entries WHERE id=$1", stale)
	if err != nil || entry["status"] != "failed" || entry["source"] != "unknown" {
		t.Fatalf("interrupted probe recovery: %v %v", entry, err)
	}
}
