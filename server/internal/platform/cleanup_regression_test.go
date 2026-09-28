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
