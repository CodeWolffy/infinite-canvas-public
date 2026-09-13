package platform

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestChannelCapabilityMigrationPreservesExistingChannels(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	// 恢复升级前的渠道结构，再走实际迁移 SQL；空库无法覆盖这次启动故障。
	if _, err := a.DB.Exec(ctx, "ALTER TABLE channels DROP COLUMN capability"); err != nil {
		t.Fatal(err)
	}
	shared := uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO channels(id,name,protocol,base_url,status,timeout_ms,max_concurrency,cooldown_seconds,key_strategy,task_adapter) VALUES($1,$2,'openai','https://example.invalid/v1','active',450000,7,45,'random','openai-video')", shared, strings.Repeat("渠道", 60)); err != nil {
		t.Fatal(err)
	}
	sealed, err := a.seal("upgrade-fixture-key")
	if err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"active", "disabled"} {
		if _, err := a.DB.Exec(ctx, "INSERT INTO channel_keys(channel_id,encrypted_api_key,key_hint,status,disabled_reason) VALUES($1,$2,'fixture',$3,$4)", shared, sealed, status, "preserved-reason"); err != nil {
			t.Fatal(err)
		}
	}
	bindings := map[string]string{}
	for _, capability := range []string{"image", "text", "video", "audio"} {
		model := uuid.NewString()
		if _, err := a.DB.Exec(ctx, "INSERT INTO models(id,name,display_name,capability) VALUES($1,$2::text,$2::text,$2::text)", model, capability); err != nil {
			t.Fatal(err)
		}
		var binding string
		if err := a.DB.QueryRow(ctx, `INSERT INTO model_channels(model_id,channel_id,upstream_model,priority,weight,enabled,cost_config) VALUES($1,$2,'upstream',9,70,$3,'{"fixed":"0.12"}') RETURNING id`, model, shared, capability != "audio").Scan(&binding); err != nil {
			t.Fatal(err)
		}
		bindings[capability] = binding
	}
	monitor := Monitoring{IntervalMinutes: 15, BindingIDs: []string{bindings["image"], bindings["text"], bindings["video"], bindings["audio"]}, Prompt: "preserved prompt", CheckModels: true}
	if _, err := a.DB.Exec(ctx, "UPDATE channels SET monitoring=$2,next_check_at=now(),monitor_token=$3,monitor_deadline=now()+interval '1 minute' WHERE id=$1", shared, jsonBytes(monitor), uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	singleText, deleted := uuid.NewString(), uuid.NewString()
	if _, err := a.DB.Exec(ctx, "INSERT INTO channels(id,name,protocol,base_url) VALUES($1,'single-text','gemini','https://example.invalid')", singleText); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO model_channels(model_id,channel_id,upstream_model) SELECT model_id,$1,'single' FROM model_channels WHERE id=$2", singleText, bindings["text"]); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO channels(id,name,protocol,base_url,deleted_at) VALUES($1,'deleted','openai','https://example.invalid',now())", deleted); err != nil {
		t.Fatal(err)
	}
	before, err := rows(ctx, a.DB, "SELECT id,model_id,upstream_model,priority,weight,enabled,cost_config FROM model_channels ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	unbound := []struct{ protocol, adapter, capability string }{{"openai", "", "image"}, {"anthropic", "", "text"}, {"gemini", "gemini-video", "video"}}
	unboundIDs := []string{}
	for _, item := range unbound {
		id := uuid.NewString()
		if _, err := a.DB.Exec(ctx, "INSERT INTO channels(id,name,protocol,base_url,task_adapter) VALUES($1,'unbound',$2,'https://example.invalid',$3)", id, item.protocol, item.adapter); err != nil {
			t.Fatal(err)
		}
		unboundIDs = append(unboundIDs, id)
	}
	migration, err := os.ReadFile("../../migrations/014_channel_capability.sql")
	if err != nil {
		t.Fatal(err)
	}
	if err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, string(migration))
		return err
	}); err != nil {
		t.Fatalf("existing-channel upgrade must succeed: %v", err)
	}
	after, err := rows(ctx, a.DB, "SELECT id,model_id,upstream_model,priority,weight,enabled,cost_config FROM model_channels ORDER BY id")
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("binding identity, routing or costs changed: %v", err)
	}
	for capability, binding := range bindings {
		channel, err := one(ctx, a.DB, "SELECT c.*,char_length(c.name) AS name_length FROM channels c JOIN model_channels b ON b.channel_id=c.id WHERE b.id=$1", binding)
		if err != nil {
			t.Fatal(err)
		}
		if channel["capability"] != capability || channel["status"] != "active" || channel["keyStrategy"] != "random" || integer(channel["timeoutMs"]) != 450000 || integer(channel["maxConcurrency"]) != 7 || integer(channel["cooldownSeconds"]) != 45 || integer(channel["nameLength"]) > 120 {
			t.Fatalf("%s channel settings were not preserved", capability)
		}
		if (str(channel["id"]) == shared) != (capability == "image") || (str(channel["taskAdapter"]) == "openai-video") != (capability == "video") {
			t.Fatalf("%s channel identity or adapter is incorrect", capability)
		}
		if capability != "image" && (channel["monitorToken"] != nil || channel["monitorDeadline"] != nil) {
			t.Fatal("new channel inherited another channel's monitor lease")
		}
		var config Monitoring
		if err := json.Unmarshal(jsonBytes(channel["monitoring"]), &config); err != nil || !reflect.DeepEqual(config.BindingIDs, []string{binding}) || config.IntervalMinutes != 15 || config.Prompt != monitor.Prompt || !config.CheckModels {
			t.Fatalf("%s monitoring configuration is incorrect: %v", capability, err)
		}
		var keyCount, activeKeys int
		if err := a.DB.QueryRow(ctx, "SELECT count(*),count(*) FILTER(WHERE status='active') FROM channel_keys WHERE channel_id=$1 AND encrypted_api_key=$2 AND disabled_reason='preserved-reason'", channel["id"], sealed).Scan(&keyCount, &activeKeys); err != nil || keyCount != 2 || activeKeys != 1 {
			t.Fatalf("%s encrypted keys or key status changed: %v", capability, err)
		}
	}
	for i, id := range unboundIDs {
		row, err := one(ctx, a.DB, "SELECT capability FROM channels WHERE id=$1", id)
		if err != nil || row["capability"] != unbound[i].capability {
			t.Fatalf("unbound channel classification: %v %v", row, err)
		}
	}
	var channelCount, singleBindings, deletedCount int
	if err := a.DB.QueryRow(ctx, "SELECT count(*),(SELECT count(*) FROM model_channels b JOIN channels c ON c.id=b.channel_id WHERE c.id=$1 AND c.capability='text'),(SELECT count(*) FROM channels WHERE id=$2 AND deleted_at IS NOT NULL) FROM channels", singleText, deleted).Scan(&channelCount, &singleBindings, &deletedCount); err != nil || channelCount != 9 || singleBindings != 1 || deletedCount != 1 {
		t.Fatalf("single-type or deleted channels changed: channels=%d bindings=%d deleted=%d err=%v", channelCount, singleBindings, deletedCount, err)
	}
}

func TestUnboundChannelCanChangeCapability(t *testing.T) {
	a := testApp(t)
	admin, cookie := testUser(t, a, 0)
	if _, err := a.DB.Exec(context.Background(), "UPDATE users SET role='admin' WHERE id=$1", admin); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	created := testRequest(router, "POST", "/api/admin/channels", channelCapabilityInput("image"), cookie)
	if created.Code != http.StatusOK {
		t.Fatalf("create: %d %s", created.Code, created.Body.String())
	}
	id := str(object(responseRow(t, created)["channel"])["id"])
	input := channelCapabilityInput("text")
	input["apiKeys"] = []string{}
	changed := testRequest(router, "PUT", "/api/admin/channels/"+id, input, cookie)
	if changed.Code != http.StatusOK {
		t.Fatalf("unbound channel must allow classification: %d %s", changed.Code, changed.Body.String())
	}
	channel := object(responseRow(t, changed)["channel"])
	if channel["capability"] != "text" || integer(channel["keyCount"]) != 1 {
		t.Fatal("channel classification or stored key changed incorrectly")
	}
}

func channelCapabilityInput(capability string) Row {
	return Row{"name": "分类渠道", "capability": capability, "protocol": "openai", "baseUrl": "https://example.invalid/v1", "status": "active", "apiKeys": []string{"test-key"}, "keyStrategy": "round_robin", "timeoutMs": 300000, "maxConcurrency": 20, "cooldownSeconds": 120}
}

func TestChannelCapabilityConfiguration(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	admin, cookie := testUser(t, a, 0)
	if _, err := a.DB.Exec(ctx, "UPDATE users SET role='admin' WHERE id=$1", admin); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	channels, models := map[string]string{}, map[string]string{}
	for _, capability := range []string{"image", "text", "video", "audio"} {
		response := testRequest(router, "POST", "/api/admin/channels", channelCapabilityInput(capability), cookie)
		if response.Code != http.StatusOK {
			t.Fatalf("create %s channel: %d %s", capability, response.Code, response.Body.String())
		}
		channel := object(responseRow(t, response)["channel"])
		if channel["capability"] != capability {
			t.Fatalf("channel type was not saved: %v", channel)
		}
		channels[capability] = str(channel["id"])
		models[capability], _ = capabilityModel(t, a, capability, "https://example.invalid", 0)
	}
	for modelType, model := range models {
		for channelType, channel := range channels {
			t.Run(modelType+"_"+channelType, func(t *testing.T) {
				want := http.StatusOK
				if modelType != channelType {
					want = http.StatusBadRequest
				}
				path := "/api/admin/models/" + model + "/channels/" + channel
				for _, request := range []struct {
					method, path string
					body Row
				}{
					{"PUT", path, Row{"upstreamModel": "single", "weight": 100, "enabled": true}},
					{"POST", path + "/batch", Row{"upstreamModels": []string{"batch-a", "batch-b"}, "weight": 100, "enabled": true}},
				} {
					response := testRequest(router, request.method, request.path, request.body, cookie)
					if response.Code != want {
						t.Fatalf("%s %s: %d %s", request.method, request.path, response.Code, response.Body.String())
					}
				}
			})
		}
	}
	for _, invalid := range []Row{
		{"capability": nil}, {"capability": "unknown"}, {"protocol": "anthropic"},
		{"taskAdapter": "openai-video"}, {"capability": "video", "taskAdapter": "gemini-video"},
	} {
		input := channelCapabilityInput("image")
		for key, value := range invalid {
			input[key] = value
		}
		response := testRequest(router, "POST", "/api/admin/channels", input, cookie)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("accepted invalid configuration %v: %d %s", invalid, response.Code, response.Body.String())
		}
	}
	changed := testRequest(router, "PUT", "/api/admin/channels/"+channels["image"], channelCapabilityInput("text"), cookie)
	if changed.Code != http.StatusBadRequest || responseRow(t, changed)["error"] != "capability_immutable" {
		t.Fatalf("channel type changed: %d %s", changed.Code, changed.Body.String())
	}
	for _, channel := range channels {
		if _, err := a.DB.Exec(ctx, `UPDATE channels SET monitoring='{"checkModels":true}' WHERE id=$1`, channel); err != nil {
			t.Fatal(err)
		}
	}
	checked := testRequest(router, "POST", "/api/admin/channels/check-all?capability=text", nil, cookie)
	if checked.Code != http.StatusOK || integer(responseRow(t, checked)["queued"]) != 1 {
		t.Fatalf("filtered check: %d %s", checked.Code, checked.Body.String())
	}
	for capability, channel := range channels {
		row, err := one(ctx, a.DB, "SELECT next_check_at FROM channels WHERE id=$1", channel)
		if err != nil || (row["nextCheckAt"] != nil) != (capability == "text") {
			t.Fatalf("wrong check scope for %s: %v %v", capability, row, err)
		}
	}
}

func TestMismatchedChannelCannotRun(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 0)
	if _, err := a.DB.Exec(ctx, "UPDATE users SET role='admin' WHERE id=$1", user); err != nil {
		t.Fatal(err)
	}
	imageModel, _ := capabilityModel(t, a, "image", "https://example.invalid", 0)
	_, textChannel := capabilityModel(t, a, "text", "https://example.invalid", 0)
	if _, err := a.DB.Exec(ctx, "DELETE FROM model_channels WHERE model_id=$1", imageModel); err != nil {
		t.Fatal(err)
	}
	// 模拟绕过管理接口写入的错误绑定，调度和报价也必须拒绝使用。
	if _, err := a.DB.Exec(ctx, "INSERT INTO model_channels(model_id,channel_id,upstream_model) VALUES($1,$2,'mismatch')", imageModel, textChannel); err != nil {
		t.Fatal(err)
	}
	candidates, err := a.candidates(ctx, imageModel, nil, nil)
	if err != nil || len(candidates) != 0 {
		t.Fatalf("mismatched channel was scheduled: %v %v", candidates, err)
	}
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := modelForTask(ctx, tx, imageModel); err == nil {
		t.Fatal("model admission accepted a mismatched channel")
	}
	response := testRequest(a.Router(), "POST", "/api/admin/playground/test", Row{"channelId": textChannel, "model": "mismatch", "capability": "image", "prompt": "test"}, cookie)
	if response.Code != http.StatusBadRequest || responseRow(t, response)["error"] != "invalid_capability" {
		t.Fatalf("playground accepted the wrong type: %d %s", response.Code, response.Body.String())
	}
}
