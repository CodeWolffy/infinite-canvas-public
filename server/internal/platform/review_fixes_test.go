package platform

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tmaxmax/go-sse"
)

// 用户状态变更不需要二次验证，前端只发 {status}；角色变更必须带 securityProof。
func TestUserStatusPatchDoesNotRequireSecurityProof(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	adminID, cookie, password := testAdmin(t, a)
	victim, _ := testUser(t, a, 0)
	router := a.Router()
	statusPath := "/api/admin/users/" + victim + "/status"
	if response := testRequest(router, "PATCH", statusPath, map[string]any{"status": "disabled"}, cookie); response.Code != 200 {
		t.Fatalf("状态变更不应要求二次验证: %d %s", response.Code, response.Body.String())
	}
	var status string
	if err := a.DB.QueryRow(ctx, "SELECT status FROM users WHERE id=$1", victim).Scan(&status); err != nil || status != "disabled" {
		t.Fatalf("状态未写入: %s %v", status, err)
	}
	if response := testRequest(router, "PATCH", statusPath, map[string]any{"status": "active"}, cookie); response.Code != 200 {
		t.Fatalf("恢复状态失败: %d %s", response.Code, response.Body.String())
	}
	rolePath := "/api/admin/users/" + victim + "/role"
	if response := testRequest(router, "PATCH", rolePath, map[string]any{"role": "admin"}, cookie); response.Code != 400 || responseRow(t, response)["error"] != "security_proof_required" {
		t.Fatalf("缺少二次验证时角色变更应被拒: %d %s", response.Code, response.Body.String())
	}
	if response := testRequest(router, "PATCH", rolePath, map[string]any{"role": "admin", "securityProof": map[string]string{"password": "wrong-password"}}, cookie); response.Code != 400 || responseRow(t, response)["error"] != "invalid_password" {
		t.Fatalf("密码错误时角色变更应被拒: %d %s", response.Code, response.Body.String())
	}
	var role string
	if err := a.DB.QueryRow(ctx, "SELECT role FROM users WHERE id=$1", victim).Scan(&role); err != nil || role != "user" {
		t.Fatalf("二次验证失败时不应改动角色: %s %v", role, err)
	}
	if response := testRequest(router, "PATCH", rolePath, map[string]any{"role": "admin", "securityProof": map[string]string{"password": password}}, cookie); response.Code != 200 {
		t.Fatalf("正确的二次验证应通过: %d %s", response.Code, response.Body.String())
	}
	var detail string
	if err := a.DB.QueryRow(ctx, "SELECT detail::text FROM audit_logs WHERE actor_id=$1 AND action='user.role' AND target=$2 ORDER BY created_at DESC LIMIT 1", adminID, victim).Scan(&detail); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(detail, password) || strings.Contains(detail, "securityProof") {
		t.Fatalf("审计详情不应包含管理员密码: %s", detail)
	}
}

// 审核拒绝与取消都发生在 worker 之外，文本 SSE 必须仍能在一次心跳内收到终态快照。
func TestTextSSEReceivesModerationAndCancelTransitions(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, 5*moneyScale)
	admin, adminCookie := testUser(t, a, 0)
	if _, err := a.DB.Exec(ctx, "UPDATE users SET role='admin' WHERE id=$1", admin); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(ctx, "INSERT INTO sensitive_words(pattern,action) VALUES('review-me','review')"); err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("审核中的任务不应调用上游")
	}))
	defer upstream.Close()
	model, _ := capabilityModel(t, a, "text", upstream.URL, moneyScale)
	router := a.Router()
	server := httptest.NewServer(router)
	defer server.Close()

	watch := func(requestID string) (<-chan string, context.CancelFunc) {
		statuses := make(chan string, 8)
		streamCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		req, _ := http.NewRequestWithContext(streamCtx, "GET", server.URL+"/api/text/requests/"+requestID+"/events", nil)
		req.AddCookie(cookie)
		response, err := server.Client().Do(req)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		go func() {
			defer close(statuses)
			defer response.Body.Close()
			for event, err := range sse.Read(response.Body, nil) {
				if err != nil || event.Type != "snapshot" {
					continue
				}
				var data Row
				if err := json.Unmarshal([]byte(event.Data), &data); err != nil {
					continue
				}
				statuses <- str(object(data["request"])["status"])
			}
		}()
		return statuses, cancel
	}
	expect := func(statuses <-chan string, want string) {
		t.Helper()
		deadline := time.After(6 * time.Second)
		for {
			select {
			case status, ok := <-statuses:
				if !ok {
					t.Fatalf("SSE 已结束但没有收到 %s 快照", want)
				}
				if status == want {
					return
				}
			case <-deadline:
				t.Fatalf("超时未收到 %s 快照", want)
			}
		}
	}

	// 场景一：审核拒绝。
	rejectedID := uuid.NewString()
	if response := testRequest(router, "POST", "/api/text/requests", Row{"requestId": rejectedID, "modelId": model, "content": "review-me first"}, cookie); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	row, err := one(ctx, a.DB, "SELECT status,moderation_id FROM generation_tasks WHERE id=$1", rejectedID)
	if err != nil || row["status"] != "reviewing" {
		t.Fatalf("not held for review: %v %v", row, err)
	}
	statuses, stop := watch(rejectedID)
	expect(statuses, "reviewing")
	if response := testRequest(router, "POST", "/api/admin/moderation/"+str(row["moderationId"])+"/decision", Row{"decision": "rejected", "note": "请调整"}, adminCookie); response.Code != 204 {
		t.Fatal(response.Body.String())
	}
	expect(statuses, "failed")
	stop()

	// 场景二：用户取消。
	canceledID := uuid.NewString()
	if response := testRequest(router, "POST", "/api/text/requests", Row{"requestId": canceledID, "modelId": model, "content": "review-me second"}, cookie); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	statuses, stop = watch(canceledID)
	expect(statuses, "reviewing")
	if response := testRequest(router, "POST", "/api/generation-tasks/"+canceledID+"/cancel", nil, cookie); response.Code != 204 {
		t.Fatal(response.Body.String())
	}
	expect(statuses, "canceled")
	stop()
	testBalance(t, a, user, 5*moneyScale, 0)
}
