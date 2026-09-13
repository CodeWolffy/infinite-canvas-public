package platform

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChannelProbeErrorsExplainFailureWithoutKeys(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	admin, cookie := testUser(t, a, 0)
	if _, err := a.DB.Exec(ctx, "UPDATE users SET role='admin' WHERE id=$1", admin); err != nil {
		t.Fatal(err)
	}
	const secret = "probe-secret-\"quoted\""
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/invalid/models" {
			_, _ = fmt.Fprint(w, "not a model list")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		if r.URL.Path == "/long/models" {
			_ = json.NewEncoder(w).Encode(Row{"error": Row{"message": strings.Repeat("x", 987) + secret}})
			return
		}
		encoded, _ := json.Marshal(secret)
		_ = json.NewEncoder(w).Encode(Row{"error": Row{"message": fmt.Sprintf("上游维护中：%s / %s", secret, encoded)}})
	}))
	defer upstream.Close()
	_, channel := capabilityModel(t, a, "image", upstream.URL, 0)
	sealed, err := a.seal(secret)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "UPDATE channel_keys SET encrypted_api_key=$2 WHERE channel_id=$1", channel, sealed); err != nil {
		t.Fatal(err)
	}
	router := a.Router()
	for _, sample := range []struct {
		name         string
		allowPrivate bool
		path         string
		want         []string
	}{
		{"upstream", true, "", []string{"HTTP 503", "上游维护中", "[REDACTED]"}},
		{"network", false, "", []string{"禁止访问内网或保留地址", "127.0.0.1", "DNS"}},
		{"invalid_response", true, "/invalid", []string{"上游未返回有效的模型列表"}},
		{"truncated_secret", true, "/long", []string{"HTTP 503", "[REDACTED]"}},
	} {
		t.Run(sample.name, func(t *testing.T) {
			a.Config.AllowPrivateHosts = sample.allowPrivate
			if _, err := a.DB.Exec(ctx, "UPDATE channels SET base_url=$2 WHERE id=$1", channel, upstream.URL+sample.path); err != nil {
				t.Fatal(err)
			}
			response := testRequest(router, "POST", "/api/admin/channels/"+channel+"/models", nil, cookie)
			if response.Code != http.StatusBadGateway {
				t.Fatalf("unexpected probe status: %d", response.Code)
			}
			body := responseRow(t, response)
			message := str(body["message"])
			for _, expected := range sample.want {
				if !strings.Contains(message, expected) {
					t.Fatalf("probe error does not explain %q", expected)
				}
			}
			if body["error"] != "probe_failed" || strings.Contains(message, "probe-secret") || strings.Contains(message, "余额") {
				t.Fatal("probe error code changed, credential leaked or unrelated billing message appeared")
			}
		})
	}
}
