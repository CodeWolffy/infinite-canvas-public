package platform

import (
	"context"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestShareLinkCreationLifecycle(t *testing.T) {
	if os.Getenv("TEST_REDIS_ADDR") == "" {
		t.Skip("需要独立的 TEST_REDIS_ADDR")
	}
	for _, kind := range []string{"canvas", "asset"} {
		t.Run(kind, func(t *testing.T) {
			a := testApp(t)
			ctx := context.Background()
			owner, cookie := testUser(t, a, 0)
			_, otherCookie := testUser(t, a, 0)
			id := uuid.NewString()
			path := "/api/canvas-projects/" + id + "/share"
			query := "INSERT INTO canvas_projects(id,user_id,title,snapshot) VALUES($1,$2,'分享测试','{}')"
			if kind == "asset" {
				path = "/api/assets/" + id + "/share"
				query = "INSERT INTO assets(id,owner_id,type,title,content) VALUES($1,$2,'text','分享测试','正文')"
			}
			if _, err := a.DB.Exec(ctx, query, id, owner); err != nil {
				t.Fatal(err)
			}
			router := a.Router()
			read := testRequest(router, http.MethodGet, path, nil, cookie)
			if read.Code != http.StatusOK || responseRow(t, read)["share"] != nil {
				t.Fatalf("首次创建前应无链接: %d %s", read.Code, read.Body.String())
			}
			denied := testRequest(router, http.MethodPost, path, nil, otherCookie)
			if denied.Code != http.StatusNotFound {
				t.Fatalf("非所有者不得创建分享: %d %s", denied.Code, denied.Body.String())
			}
			create := func() Row {
				t.Helper()
				response := testRequest(router, http.MethodPost, path, nil, cookie)
				if response.Code != http.StatusOK {
					var persisted int
					if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM share_links WHERE kind=$1 AND target_id=$2", kind, id).Scan(&persisted); err != nil {
						t.Fatal(err)
					}
					t.Fatalf("创建应立即返回链接，不能已落库却报错（已存 %d 条）: %d %s", persisted, response.Code, response.Body.String())
				}
				share := object(responseRow(t, response)["share"])
				if str(share["token"]) == "" || share["url"] != "/s/"+str(share["token"]) {
					t.Fatalf("创建响应缺少可用链接: %v", share)
				}
				created, err := time.Parse(time.RFC3339Nano, str(share["createdAt"]))
				if err != nil {
					t.Fatal(err)
				}
				expires, err := time.Parse(time.RFC3339Nano, str(share["expiresAt"]))
				if err != nil || expires.Sub(created) != shareLifetimeDays*24*time.Hour {
					t.Fatalf("创建响应应保留原有效期: %v %v", share, err)
				}
				return share
			}
			first := create()
			repeated := create()
			if repeated["token"] != first["token"] || repeated["expiresAt"] != first["expiresAt"] {
				t.Fatalf("重复创建应返回同一有效链接: %v %v", first, repeated)
			}
			read = testRequest(router, http.MethodGet, path, nil, cookie)
			if read.Code != http.StatusOK || object(responseRow(t, read)["share"])["token"] != first["token"] {
				t.Fatalf("创建结果应与随后读取一致: %d %s", read.Code, read.Body.String())
			}
			public := testRequest(router, http.MethodGet, "/api/shared/"+str(first["token"]), nil, nil)
			if public.Code != http.StatusOK || responseRow(t, public)["kind"] != kind {
				t.Fatalf("新链接应立即可访问: %d %s", public.Code, public.Body.String())
			}
			if _, err := a.DB.Exec(ctx, "UPDATE share_links SET expires_at=now()-interval '1 day' WHERE token=$1", first["token"]); err != nil {
				t.Fatal(err)
			}
			renewed := create()
			if renewed["token"] == first["token"] {
				t.Fatal("过期后创建必须更换 token")
			}
			var active int
			if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM share_links WHERE kind=$1 AND target_id=$2 AND revoked_at IS NULL", kind, id).Scan(&active); err != nil || active != 1 {
				t.Fatalf("重新创建应只保留一个有效链接: %d %v", active, err)
			}
			if expired := testRequest(router, http.MethodGet, "/api/shared/"+str(first["token"]), nil, nil); expired.Code != http.StatusNotFound {
				t.Fatalf("过期旧链接仍可访问: %d %s", expired.Code, expired.Body.String())
			}
			if revoked := testRequest(router, http.MethodDelete, path, nil, cookie); revoked.Code != http.StatusNoContent {
				t.Fatalf("撤销失败: %d %s", revoked.Code, revoked.Body.String())
			}
			if revoked := testRequest(router, http.MethodGet, "/api/shared/"+str(renewed["token"]), nil, nil); revoked.Code != http.StatusNotFound {
				t.Fatalf("撤销后旧链接仍可访问: %d %s", revoked.Code, revoked.Body.String())
			}
			if recreated := create(); recreated["token"] == renewed["token"] {
				t.Fatal("撤销后创建必须返回新链接")
			}
		})
	}
}
