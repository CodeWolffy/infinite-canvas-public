package platform

import (
	"context"
	"net/http"
	"testing"
)

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
