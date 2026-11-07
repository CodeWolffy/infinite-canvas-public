package platform

import (
	"context"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestCanvasRealtimeMigrationPreservesPrivateHistoryAndQuota(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("需要独立的 TEST_DATABASE_URL")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := pgx.Identifier{"test_realtime_" + strings.ReplaceAll(uuid.NewString(), "-", "")}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE") }()
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	db, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	scripts := loadMigrationScripts(t)
	for _, script := range scripts[:26] {
		if _, err := db.Exec(ctx, script); err != nil {
			t.Fatal(err)
		}
	}
	userID, projectID, historyID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	sharedID, privateID := uuid.NewString(), uuid.NewString()
	snapshot := privateCanvasSnapshot(sharedID)
	snapshot["chatSessions"] = []any{map[string]any{"id": "private-chat", "mediaId": privateID, "content": "private old history"}}
	// 普通文本中的 UUID 不构成共享媒体引用。
	snapshot["nodes"].([]any)[0].(map[string]any)["title"] = privateID
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{"INSERT INTO users(id,username,password_hash,display_name) VALUES($1,$2,'unused','owner')", []any{userID, userID}},
		{"INSERT INTO canvas_projects(id,user_id,title,snapshot) VALUES($1,$2,'legacy',$3)", []any{projectID, userID, jsonBytes(snapshot)}},
		{"INSERT INTO canvas_project_history(id,project_id,user_id,title,snapshot) VALUES($1,$2,$3,'legacy history',$4)", []any{historyID, projectID, userID, jsonBytes(snapshot)}},
	} {
		if _, err := db.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	for _, mediaID := range []string{sharedID, privateID} {
		if _, err := db.Exec(ctx, "INSERT INTO media_objects(id,owner_id,object_key,original_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,'image.png','image/png',1,'hash')", mediaID, userID, uuid.NewString()); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(ctx, "INSERT INTO media_references(owner_kind,owner_id,user_id,media_id) VALUES('canvas',$1,$3,$4),('history',$2,$3,$4)", projectID, historyID, userID, mediaID); err != nil {
			t.Fatal(err)
		}
	}
	if err := pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		// 已超额旧用户仍应能升级；新版本继续按真实行大小计量。
		if _, err := tx.Exec(ctx, "SELECT set_config('ic.user_content_quota_bytes','1',true)"); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, scripts[26])
		return err
	}); err != nil {
		t.Fatalf("nonempty upgrade failed: %v", err)
	}
	for _, query := range []string{"SELECT snapshot FROM canvas_projects WHERE id=$1", "SELECT snapshot FROM canvas_project_history WHERE project_id=$1"} {
		row, err := one(ctx, db, query, projectID)
		if err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"viewport", "chatSessions", "activeChatId"} {
			if _, exists := object(row["snapshot"])[key]; exists {
				t.Fatalf("shared migrated snapshot contains %s", key)
			}
		}
	}
	state, err := one(ctx, db, "SELECT viewport,chat_sessions,active_chat_id FROM canvas_user_views WHERE project_id=$1 AND user_id=$2", projectID, userID)
	if err != nil || !reflect.DeepEqual(state["chatSessions"], snapshot["chatSessions"]) || state["activeChatId"] != "private-chat" {
		t.Fatalf("private state lost: %v %v", state, err)
	}
	history, err := one(ctx, db, "SELECT snapshot FROM canvas_history_personal WHERE history_id=$1", historyID)
	if err != nil || !reflect.DeepEqual(object(history["snapshot"])["chatSessions"], snapshot["chatSessions"]) {
		t.Fatalf("private history lost: %v %v", history, err)
	}
	var publicRefs, personalRefs int
	if err := db.QueryRow(ctx, "SELECT count(*) FILTER(WHERE owner_kind IN ('canvas','history')),count(*) FILTER(WHERE owner_kind IN ('canvas_personal','canvas_history_personal')) FROM media_references WHERE media_id=$1", privateID).Scan(&publicRefs, &personalRefs); err != nil || publicRefs != 0 || personalRefs != 2 {
		t.Fatalf("private media authorization was not separated: public=%d private=%d %v", publicRefs, personalRefs, err)
	}
	var actual, expected int64
	if err := db.QueryRow(ctx, `SELECT (SELECT byte_size FROM user_content_usage WHERE user_id=$1),
		(SELECT sum(bytes) FROM (
			SELECT octet_length(to_jsonb(p)::text)::bigint AS bytes FROM canvas_projects p WHERE user_id=$1
			UNION ALL SELECT octet_length(to_jsonb(h)::text)::bigint FROM canvas_project_history h WHERE user_id=$1
			UNION ALL SELECT octet_length(to_jsonb(v)::text)::bigint FROM canvas_user_views v WHERE user_id=$1
			UNION ALL SELECT octet_length(to_jsonb(hp)::text)::bigint FROM canvas_history_personal hp WHERE user_id=$1
		) content)`, userID).Scan(&actual, &expected); err != nil || actual != expected {
		t.Fatalf("migrated quota differs from stored rows: actual=%d expected=%d %v", actual, expected, err)
	}
}
