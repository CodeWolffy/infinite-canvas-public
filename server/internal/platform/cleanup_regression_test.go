package platform

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

func TestCleanupPreservesRetryInputAndPendingModeration(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, moneyScale)
	if _, err := a.DB.Exec(ctx, "UPDATE users SET role='admin' WHERE id=$1", user); err != nil {
		t.Fatal(err)
	}
	model, _ := capabilityModel(t, a, "image", "https://example.invalid", 0)
	batches := map[string]string{}
	for _, status := range []string{"failed", "canceled", "succeeded"} {
		response := testRequest(a.Router(), "POST", "/api/generation-batches", Row{"requestId": uuid.NewString(), "modelId": model, "prompt": "保留原提示词", "count": 1, "parameters": Row{"size": "1024x1024"}}, cookie)
		if response.Code != 200 {
			t.Fatal(response.Body.String())
		}
		id, err := one(ctx, a.DB, "SELECT id FROM generation_tasks WHERE user_id=$1 AND status='queued'", user)
		if err != nil {
			t.Fatal(err)
		}
		batches[status] = str(id["id"])
		if _, err := a.DB.Exec(ctx, "UPDATE generation_tasks SET status=$2,finished_at=now()-interval '91 days',partial_text='intermediate',channel_snapshot='unused' WHERE id=$1", id["id"], status); err != nil {
			t.Fatal(err)
		}
	}
	for _, status := range []string{"pending", "approved"} {
		id := uuid.NewString()
		if _, err := a.DB.Exec(ctx, `INSERT INTO moderation_reviews(id,user_id,matches,request_snapshot,status,created_at,reviewed_at)
			VALUES($1,$2,'[]',$3,$4,now()-interval '91 days',CASE WHEN $4='pending' THEN NULL ELSE now()-interval '91 days' END)`, id, user, jsonBytes(Row{"prompt": "待审核内容", "parameters": Row{"size": "1024x1024"}, "modelDisplayName": "审核模型", "capability": "image", "taskCount": 1}), status); err != nil {
			t.Fatal(err)
		}
		if status == "approved" {
			if _, err := a.DB.Exec(ctx, "UPDATE generation_tasks SET moderation_id=$2 WHERE id=$1", batches["succeeded"], id); err != nil {
				t.Fatal(err)
			}
		}
	}
	a.cleanup(ctx)
	for status, id := range batches {
		row, err := one(ctx, a.DB, "SELECT prompt,parameters,partial_text,channel_snapshot FROM generation_tasks WHERE id=$1", id)
		if err != nil || row["partialText"] != "" || row["channelSnapshot"] != nil {
			t.Fatalf("终态中间结果应清理: %v %v", row, err)
		}
		if status == "succeeded" {
			if row["prompt"] != "" || len(object(row["parameters"])) != 0 {
				t.Fatal("成功任务输入应按保留期清理")
			}
			continue
		}
		if row["prompt"] != "保留原提示词" || object(row["parameters"])["size"] != "1024x1024" {
			t.Fatalf("清理破坏了重试输入: %v", row)
		}
		response := testRequest(a.Router(), "POST", "/api/generation-batches/tasks/"+id+"/retry", nil, cookie)
		if response.Code != 200 {
			t.Fatalf("清理后应能重试: %d %s", response.Code, response.Body.String())
		}
		row, err = one(ctx, a.DB, "SELECT prompt,parameters,status,run FROM generation_tasks WHERE id=$1", id)
		if err != nil || row["status"] != "queued" || integer(row["run"]) != 2 || row["prompt"] != "保留原提示词" || object(row["parameters"])["size"] != "1024x1024" {
			t.Fatalf("重试未保留原输入: %v %v", row, err)
		}
	}
	response := testRequest(a.Router(), "GET", "/api/admin/moderation?status=", nil, cookie)
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	reviews, _ := responseRow(t, response)["reviews"].([]any)
	if len(reviews) != 2 {
		t.Fatalf("待审核与已完成审核均应保留: %v", reviews)
	}
	for _, value := range reviews {
		review := object(value)
		if review["parameters"] == nil || review["modelDisplayName"] != "审核模型" {
			t.Fatalf("审核接口缺少必需字段: %v", review)
		}
		if review["status"] == "pending" {
			if review["prompt"] != "待审核内容" || review["snapshotExpired"] != false {
				t.Fatal("待审核内容不应清理")
			}
		} else if review["prompt"] != "" || review["snapshotExpired"] != true || len(object(review["parameters"])) != 0 {
			t.Fatalf("完成审核应标明正文已清理: %v", review)
		}
	}
	testBalance(t, a, user, moneyScale, 0)
}

func TestCleanupKeepsMediaUntilObjectDeletionSucceeds(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	user, _ := testUser(t, a, 0)
	goodID, badID := uuid.NewString(), uuid.NewString()
	goodKey, badKey := uuid.NewString(), uuid.NewString()
	for _, item := range []struct{ id, key string }{{goodID, goodKey}, {badID, badKey}} {
		if _, err := a.DB.Exec(ctx, "INSERT INTO media_objects(id,owner_id,object_key,original_name,mime_type,byte_size,sha256,status) VALUES($1,$2,$3,'test.png','image/png',1,'hash','deleting')", item.id, user, item.key); err != nil {
			t.Fatal(err)
		}
	}

	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !r.URL.Query().Has("delete") {
			t.Errorf("unexpected S3 request: %s %s", r.Method, r.URL)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		calls++
		w.Header().Set("Content-Type", "application/xml")
		if calls == 1 {
			fmt.Fprintf(w, "<DeleteResult><Deleted><Key>%s</Key></Deleted><Error><Key>%s</Key><Code>AccessDenied</Code><Message>denied</Message></Error></DeleteResult>", goodKey, badKey)
			return
		}
		fmt.Fprintf(w, "<DeleteResult><Deleted><Key>%s</Key></Deleted></DeleteResult>", badKey)
	}))
	defer server.Close()
	client, err := minio.New(server.Listener.Addr().String(), &minio.Options{Creds: credentials.NewStaticV4("test", "test", ""), Region: "us-east-1"})
	if err != nil {
		t.Fatal(err)
	}
	a.S3 = client

	status := func(id string, want string) {
		t.Helper()
		var got string
		err := a.DB.QueryRow(ctx, "SELECT status FROM media_objects WHERE id=$1", id).Scan(&got)
		if want == "" {
			if !errors.Is(err, pgx.ErrNoRows) {
				t.Fatalf("media %s should be removed, status=%q err=%v", id, got, err)
			}
		} else if err != nil || got != want {
			t.Fatalf("media %s status=%q err=%v, want %q", id, got, err, want)
		}
	}

	a.cleanup(ctx)
	status(goodID, "")
	status(badID, "deleting")

	bucket := a.Config.Bucket
	a.Config.Bucket = "INVALID BUCKET"
	a.cleanup(ctx)
	status(badID, "deleting")
	a.Config.Bucket = bucket
	a.cleanup(ctx)
	status(badID, "")
	if calls != 2 {
		t.Fatalf("S3 delete calls=%d, want 2", calls)
	}
}
