package platform

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestTextContextEstimateIsAdvisory(t *testing.T) {
	input := textInput{Content: "hello world", Parameters: Row{"max_tokens": 8}}
	for _, sample := range []struct {
		name       string
		capacity   any
		images     int64
		wantTokens any
		warning    bool
	}{
		{"unconfigured", nil, 0, nil, false},
		{"text", 20, 0, int64(2), false},
		{"exact_capacity", 10, 0, int64(2), false},
		{"over_capacity", 9, 0, int64(2), true},
		{"image_unknown", 9, 1, nil, false},
	} {
		t.Run(sample.name, func(t *testing.T) {
			result, err := summarizeTextContext(Row{"config": Row{"contextWindowTokens": sample.capacity}}, nil, input, 1, sample.images)
			if err != nil || result["estimatedTokens"] != sample.wantTokens || (result["warning"] != nil) != sample.warning || result["estimateNote"] == "" {
				t.Fatalf("context: %v %v", result, err)
			}
		})
	}
	for _, value := range []any{"100", 1.5, 0, -1, true} {
		if _, err := modelTextParameters(Row{"config": Row{"maxOutputTokens": 8, "contextWindowTokens": value}}, nil); err == nil {
			t.Fatalf("accepted invalid context window: %v", value)
		}
	}
}

func TestTextConversationSingleTimelineAndMetadata(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, moneyScale)
	var received []Row
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request Row
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		received = append(received, request)
		fmt.Fprint(w, `{"choices":[{"message":{"content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2}}`)
	}))
	defer upstream.Close()
	model, _ := capabilityModel(t, a, "text", upstream.URL, 0)
	if _, err := a.DB.Exec(ctx, `UPDATE models SET input_price_per_million=1000000,output_price_per_million=1000000,config='{"maxOutputTokens":128,"contextWindowTokens":1000,"reasoningEfforts":["high"]}' WHERE id=$1`, model); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	post := func(input Row) Row {
		t.Helper()
		response := testRequest(router, "POST", "/api/text/requests", input, cookie)
		if response.Code != 200 {
			t.Fatalf("submit: %d %s", response.Code, response.Body.String())
		}
		return responseRow(t, response)
	}
	detail := func(conversation string) Row {
		t.Helper()
		response := testRequest(router, "GET", "/api/text/conversations/"+conversation, nil, cookie)
		if response.Code != 200 {
			t.Fatal(response.Body.String())
		}
		return responseRow(t, response)
	}
	first := Row{"requestId": uuid.NewString(), "modelId": model, "content": "original question", "systemPrompt": "stay concise", "parameters": Row{"reasoningEffort": "high"}}
	conversation := str(post(first)["conversationId"])
	a.executeGuarded(ctx, claimForTest(t, a, user))
	second := maps.Clone(first)
	second["requestId"], second["conversationId"], second["content"] = uuid.NewString(), conversation, "later question"
	post(second)
	a.executeGuarded(ctx, claimForTest(t, a, user))
	before := detail(conversation)["messages"].([]any)
	if len(before) != 4 {
		t.Fatalf("history: %v", before)
	}
	edit := maps.Clone(second)
	edit["requestId"], edit["action"], edit["targetMessageId"], edit["content"] = uuid.NewString(), "edit", object(before[0])["id"], "revised question"
	quote := maps.Clone(edit)
	quote["count"] = 1
	quoted := testRequest(router, "POST", "/api/generation-quote", quote, cookie)
	if quoted.Code != 200 || integer(object(responseRow(t, quoted)["context"])["messageCount"]) != 1 {
		t.Fatal(quoted.Body.String())
	}
	post(edit)
	editTask := claimForTest(t, a, user)
	wantHold, err := amountUnits(str(object(responseRow(t, quoted)["quote"])["estimatedHold"]), moneyScale)
	if err != nil || integer(editTask["priceMicros"]) != wantHold {
		t.Fatalf("quote does not match replacement: %v %v", editTask, err)
	}
	a.executeGuarded(ctx, editTask)
	if len(received) != 3 || strings.Contains(string(jsonBytes(received[2])), "original question") || strings.Contains(string(jsonBytes(received[2])), "later question") || !strings.Contains(string(jsonBytes(received[2])), "revised question") {
		t.Fatalf("superseded context sent upstream: %v", received)
	}
	after := detail(conversation)["messages"].([]any)
	if len(after) != 6 {
		t.Fatalf("old records not retained: %v", after)
	}
	for _, message := range after[:4] {
		if object(message)["supersededAt"] == nil {
			t.Fatal("old record still active")
		}
	}
	answer := object(after[5])
	if answer["supersededAt"] != nil || answer["requestId"] != edit["requestId"] || answer["requestMessageId"] != object(after[4])["id"] || answer["finishReason"] != "stop" || answer["modelDisplayName"] != "capability" || answer["billed"] != money(10) || answer["action"] != "edit" {
		t.Fatalf("answer metadata: %v", answer)
	}
	post(edit)
	if len(detail(conversation)["messages"].([]any)) != 6 || len(received) != 3 {
		t.Fatal("idempotent edit was replayed")
	}
	stale := maps.Clone(edit)
	stale["requestId"] = uuid.NewString()
	if rejected := testRequest(router, "POST", "/api/text/requests", stale, cookie); rejected.Code != 409 {
		t.Fatal(rejected.Body.String())
	}
	regen := maps.Clone(edit)
	regen["requestId"], regen["action"], regen["targetMessageId"], regen["content"] = uuid.NewString(), "regenerate", answer["id"], "forged input"
	post(regen)
	a.executeGuarded(ctx, claimForTest(t, a, user))
	if strings.Contains(string(jsonBytes(received[3])), "forged input") || !strings.Contains(string(jsonBytes(received[3])), "revised question") {
		t.Fatalf("regeneration trusted client: %v", received[3])
	}
	last := detail(conversation)
	if integer(object(last["latestRequest"])["promptTokens"]) != 8 || object(last["latestRequest"])["finishReason"] != "stop" {
		t.Fatalf("latest metadata: %v", last)
	}
	if _, err := a.DB.Exec(ctx, "UPDATE generation_tasks SET parameters='{}' WHERE conversation_id=$1", conversation); err != nil {
		t.Fatal(err)
	}
	persisted := object(detail(conversation)["conversation"])
	if persisted["modelId"] != model || object(persisted["parameters"])["systemPrompt"] != "stay concise" || object(persisted["parameters"])["reasoningEffort"] != "high" {
		t.Fatalf("settings depend on task retention: %v", persisted)
	}
	testBalance(t, a, user, moneyScale-40, 0)
}

func TestTextConversationReplacementRollbackAndHistoricalImages(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, moneyScale)
	model, _ := capabilityModel(t, a, "text", "https://example.invalid", 0)
	conversation, message, imageID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{"INSERT INTO conversations(id,user_id,title) VALUES($1,$2,'images')", []any{conversation, user}},
		{"INSERT INTO messages(id,conversation_id,role,content) VALUES($1,$2,'user','original image')", []any{message, conversation}},
		{"INSERT INTO media_objects(id,owner_id,object_key,original_name,mime_type,byte_size,sha256) VALUES($1::uuid,$2,$1::text,'image.png','image/png',12,'test')", []any{imageID, user}},
		{"INSERT INTO media_references(owner_kind,owner_id,user_id,media_id) VALUES('message',$1,$2,$3)", []any{message, user, imageID}},
	} {
		if _, err := a.DB.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	router := a.Router()
	input := Row{"requestId": uuid.NewString(), "modelId": model, "conversationId": conversation, "content": "follow up", "count": 1}
	for _, path := range []string{"/api/generation-quote", "/api/text/requests"} {
		response := testRequest(router, "POST", path, input, cookie)
		if response.Code != 400 || responseRow(t, response)["error"] != "image_input_unsupported" {
			t.Fatalf("history image accepted: %s", response.Body.String())
		}
	}
	input["action"], input["targetMessageId"], input["content"] = "edit", message, "replaced without image"
	if _, err := a.DB.Exec(ctx, "UPDATE models SET price_micros=$2 WHERE id=$1", model, 2*moneyScale); err != nil {
		t.Fatal(err)
	}
	if response := testRequest(router, "POST", "/api/text/requests", input, cookie); response.Code < 400 {
		t.Fatal("insufficient balance accepted")
	}
	var superseded, tasks int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FILTER(WHERE superseded_at IS NOT NULL),(SELECT count(*) FROM generation_tasks WHERE conversation_id=$1) FROM messages WHERE conversation_id=$1", conversation).Scan(&superseded, &tasks); err != nil || superseded != 0 || tasks != 0 {
		t.Fatalf("failed replacement changed history: %d %d %v", superseded, tasks, err)
	}
	if _, err := a.DB.Exec(ctx, "UPDATE models SET price_micros=0 WHERE id=$1", model); err != nil {
		t.Fatal(err)
	}
	if response := testRequest(router, "POST", "/api/text/requests", input, cookie); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	var refs int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM media_references WHERE owner_kind='message' AND owner_id=$1", message).Scan(&refs); err != nil || refs != 1 {
		t.Fatal("superseded media reference lost")
	}
	testBalance(t, a, user, moneyScale, 0)
}

func TestTextConversationSearchPinArchiveAndOwnership(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 0)
	_, otherCookie := testUser(t, a, 0)
	conversation, message := uuid.NewString(), uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO conversations(id,user_id,title) VALUES($1,$2,'旧标题')", conversation, user); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO messages(id,conversation_id,role,content,superseded_at) VALUES($1,$2,'user','body needle exact%',now())", message, conversation); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	response := testRequest(router, "GET", "/api/text/conversations?keyword=needle", nil, cookie)
	items := responseRow(t, response)["conversations"].([]any)
	if response.Code != 200 || len(items) != 1 || object(items[0])["matchedMessageId"] != message || !strings.Contains(str(object(items[0])["excerpt"]), "needle") {
		t.Fatalf("search: %s", response.Body.String())
	}
	if response = testRequest(router, "GET", "/api/text/conversations?keyword=needle", nil, otherCookie); len(responseRow(t, response)["conversations"].([]any)) != 0 {
		t.Fatal("other user's search leaked")
	}
	path := "/api/text/conversations/" + conversation
	if response = testRequest(router, "PATCH", path, Row{"title": "新标题", "pinned": true, "archived": true}, otherCookie); response.Code != 404 {
		t.Fatal("other user patched conversation")
	}
	if response = testRequest(router, "PATCH", path, Row{"title": "新标题", "pinned": true, "archived": true}, cookie); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	if response = testRequest(router, "GET", "/api/text/conversations", nil, cookie); len(responseRow(t, response)["conversations"].([]any)) != 0 {
		t.Fatal("archived conversation stayed in active list")
	}
	response = testRequest(router, "GET", "/api/text/conversations?archived=true&keyword=needle", nil, cookie)
	items = responseRow(t, response)["conversations"].([]any)
	if len(items) != 1 || object(items[0])["pinned"] != true || object(items[0])["title"] != "新标题" || object(items[0])["archivedAt"] == nil {
		t.Fatal(response.Body.String())
	}
	if response = testRequest(router, "PATCH", path, Row{"archived": false, "pinned": false}, cookie); response.Code != 200 || object(responseRow(t, response)["conversation"])["archivedAt"] != nil {
		t.Fatal(response.Body.String())
	}
}

func TestTextConversationRegenerationUsesStoredAttachments(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, moneyScale)
	_, otherCookie := testUser(t, a, moneyScale)
	model, _ := capabilityModel(t, a, "text", "https://example.invalid", 0)
	conversation, question, answer, imageID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`UPDATE models SET config=config||'{"imageInput":true,"contextWindowTokens":1000}'::jsonb WHERE id=$1`, []any{model}},
		{"INSERT INTO conversations(id,user_id,title) VALUES($1,$2,'images')", []any{conversation, user}},
		{"INSERT INTO messages(id,conversation_id,role,content) VALUES($1,$3,'user','stored question'),($2,$3,'assistant','stored answer')", []any{question, answer, conversation}},
		{"INSERT INTO media_objects(id,owner_id,object_key,original_name,mime_type,byte_size,sha256) VALUES($1::uuid,$2,$1::text,'image.png','image/png',12,'test')", []any{imageID, user}},
		{"INSERT INTO media_references(owner_kind,owner_id,user_id,media_id) VALUES('message',$1,$2,$3)", []any{question, user, imageID}},
		{`INSERT INTO generation_tasks(user_id,model_id,model_name,model_display_name,capability,prompt,price_micros,conversation_id,request_message_id,response_message_id,status)
		VALUES($1,$2,'test','test','text','stored question',0,$3,$4,$5,'succeeded')`, []any{user, model, conversation, question, answer}},
	} {
		if _, err := a.DB.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	router := a.Router()
	input := Row{"requestId": uuid.NewString(), "modelId": model, "conversationId": conversation, "action": "regenerate", "targetMessageId": answer, "content": "forged", "attachmentMediaIds": []string{uuid.NewString()}, "count": 1}
	if response := testRequest(router, "POST", "/api/text/requests", input, otherCookie); response.Code != 404 {
		t.Fatal("foreign conversation accepted")
	}
	wrongRole := maps.Clone(input)
	wrongRole["targetMessageId"] = question
	if response := testRequest(router, "POST", "/api/text/requests", wrongRole, cookie); response.Code != 400 {
		t.Fatal("regenerated a user message")
	}
	wrongRole["action"], wrongRole["targetMessageId"] = "edit", answer
	if response := testRequest(router, "POST", "/api/text/requests", wrongRole, cookie); response.Code != 400 {
		t.Fatal("edited an assistant message")
	}
	quote := testRequest(router, "POST", "/api/generation-quote", input, cookie)
	if quote.Code != 200 {
		t.Fatal(quote.Body.String())
	}
	summary := object(responseRow(t, quote)["context"])
	if integer(summary["imageCount"]) != 1 || integer(summary["messageCount"]) != 1 || summary["estimatedTokens"] != nil {
		t.Fatalf("image estimate: %v", summary)
	}
	created := testRequest(router, "POST", "/api/text/requests", input, cookie)
	if created.Code != 200 {
		t.Fatal(created.Body.String())
	}
	task, err := one(ctx, a.DB, "SELECT * FROM generation_tasks WHERE id=$1", input["requestId"])
	if err != nil || task["prompt"] != "stored question" {
		t.Fatalf("regeneration input: %v %v", task, err)
	}
	var references int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM media_references WHERE owner_kind='message' AND media_id=$1 AND owner_id=ANY($2::uuid[])", imageID, []string{question, str(task["requestMessageId"])}).Scan(&references); err != nil || references != 2 {
		t.Fatalf("stored attachment was not preserved and reused: %d %v", references, err)
	}
}

func TestTextConversationMigrationPreservesExistingRecords(t *testing.T) {
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
	schema := "test_text_upgrade_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec(context.Background(), "DROP SCHEMA "+quoted+" CASCADE") }()
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
	for index, script := range scripts[:27] {
		if _, err := db.Exec(ctx, script); err != nil {
			t.Fatalf("migration %d: %v", index+1, err)
		}
	}
	a := &App{DB: db, Config: Config{EncryptionKey: strings.Repeat("k", 32), CookieName: "text_migration", SessionDays: 7}}
	user, _ := testUser(t, a, moneyScale)
	model, _ := capabilityModel(t, a, "text", "https://example.invalid", 0)
	conversation, empty, untouched, message := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO conversations(id,user_id,title) VALUES($1,$4,'saved'),($2,$4,'cleaned'),($3,$4,'no task')", conversation, empty, untouched, user); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO messages(id,conversation_id,role,content) VALUES($1,$2,'user','preserved')", message, conversation); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, `INSERT INTO generation_tasks(user_id,model_id,model_name,model_display_name,capability,prompt,price_micros,conversation_id,parameters,status,queued_at)
		VALUES($1,$2,'test','test','text','',0,$3,'{"systemPrompt":"older"}','succeeded',now()-interval '1 day'),
		($1,$2,'test','test','text','',0,$3,'{"systemPrompt":"kept","reasoningEffort":"high"}','succeeded',now()),
		($1,$2,'test','test','text','',0,$4,'{}','succeeded',now())`, user, model, conversation, empty); err != nil {
		t.Fatal(err)
	}
	imageID := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO media_objects(id,owner_id,object_key,original_name,mime_type,byte_size,sha256) VALUES($1::uuid,$2,$1::text,'image.png','image/png',12,'test')", imageID, user); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO media_references(owner_kind,owner_id,user_id,media_id) VALUES('message',$1,$2,$3)", message, user, imageID); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO wallet_entries(user_id,kind,reference,delta_balance,delta_frozen,balance_after,frozen_after,note) VALUES($1,'adjustment','fixture',$2,0,$2,0,'migration fixture')", user, moneyScale); err != nil {
		t.Fatal(err)
	}
	snapshot := func(table string) string {
		t.Helper()
		items, err := rows(ctx, a.DB, "SELECT * FROM "+table+" t ORDER BY to_jsonb(t)::text")
		if err != nil {
			t.Fatal(err)
		}
		return string(jsonBytes(items))
	}
	preserved := map[string]string{}
	for _, table := range []string{"wallets", "wallet_entries", "media_objects", "media_references", "channel_keys", "model_channels"} {
		preserved[table] = snapshot(table)
	}
	script, err := os.ReadFile("../../migrations/028_text_conversation.sql")
	if err != nil {
		t.Fatal(err)
	}
	if err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error { _, err := tx.Exec(ctx, string(script)); return err }); err != nil {
		t.Fatal(err)
	}
	for table, before := range preserved {
		if snapshot(table) != before {
			t.Fatalf("migration changed existing %s", table)
		}
	}
	for _, id := range []string{conversation, empty, untouched} {
		row, err := one(ctx, a.DB, "SELECT model_id,parameters,pinned,archived_at FROM conversations WHERE id=$1", id)
		if err != nil || row["pinned"] != false || row["archivedAt"] != nil {
			t.Fatalf("migration: %v %v", row, err)
		}
		if id == conversation && (row["modelId"] != model || object(row["parameters"])["systemPrompt"] != "kept") {
			t.Fatal("latest settings were not preserved")
		}
		if id != conversation && len(object(row["parameters"])) != 0 {
			t.Fatal("invented cleaned settings")
		}
		if id == untouched && row["modelId"] != nil {
			t.Fatal("invented model for empty conversation")
		}
	}
	row, err := one(ctx, a.DB, "SELECT content,superseded_at FROM messages WHERE id=$1", message)
	if err != nil || row["content"] != "preserved" || row["supersededAt"] != nil {
		t.Fatal("history changed during upgrade")
	}
	testBalance(t, a, user, moneyScale, 0)
}
