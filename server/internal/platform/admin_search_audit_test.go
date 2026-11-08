package platform

import (
	"context"
	"testing"
)

func TestAdminUserSearchPaginatesBeyondRecentUsers(t *testing.T) {
	a := testApp(t)
	_, cookie, _ := testAdmin(t, a)
	ctx := context.Background()
	_, err := a.DB.Exec(ctx, `WITH added AS (
		INSERT INTO users(username,password_hash,display_name,created_at)
		SELECT 'person_' || lpad(n::text,3,'0'),'unused',CASE WHEN n<=3 THEN 'needle ' || n ELSE '普通用户' END,
		CASE WHEN n<=3 THEN now()-interval '100 days' ELSE now() END FROM generate_series(1,203) n RETURNING id
	) INSERT INTO wallets(user_id) SELECT id FROM added`)
	if err != nil { t.Fatal(err) }
	seen := map[string]bool{}
	for _, offset := range []string{"0", "2"} {
		response := testRequest(a.Router(), "GET", "/api/admin/users?limit=2&offset="+offset+"&keyword=NEEDLE", nil, cookie)
		if response.Code != 200 { t.Fatal(response.Body.String()) }
		body := responseRow(t, response)
		if integer(body["total"]) != 3 { t.Fatalf("search did not count all users: %v", body) }
		items, _ := body["users"].([]any)
		for _, value := range items {
			id := str(object(value)["id"])
			if seen[id] { t.Fatal("same timestamp caused duplicate pagination") }
			seen[id] = true
		}
	}
	if len(seen) != 3 { t.Fatalf("missing remote search results: %d", len(seen)) }
	response := testRequest(a.Router(), "GET", "/api/admin/users?keyword=PERSON_001", nil, cookie)
	if response.Code != 200 || integer(responseRow(t, response)["total"]) != 1 { t.Fatal("username search failed: ", response.Body.String()) }
}

func TestRequestLogClearIsAuditedAtomically(t *testing.T) {
	a := routingApp(t)
	admin, cookie, password := testAdmin(t, a)
	ctx := context.Background()
	if _, err := a.DB.Exec(ctx, "INSERT INTO request_logs(user_id,type,status) VALUES($1,'image','succeeded'),($1,'text','failed'),($1,'image','running')", admin); err != nil { t.Fatal(err) }
	response := testRequest(a.Router(), "DELETE", "/api/admin/request-logs", Row{"securityProof": securityProof{Password: password}}, cookie)
	if response.Code != 200 || integer(responseRow(t, response)["deleted"]) != 2 { t.Fatal(response.Body.String()) }
	entry, err := one(ctx, a.DB, "SELECT actor_id,target,detail FROM audit_logs WHERE action='request-logs.clear'")
	if err != nil || str(entry["actorId"]) != admin || entry["target"] != "request-logs" || integer(object(entry["detail"])["deleted"]) != 2 || object(entry["detail"])["retainedStatus"] != "running" { t.Fatalf("clear audit mismatch: %v %v", entry, err) }
	var count int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM request_logs WHERE status='running'").Scan(&count); err != nil || count != 1 { t.Fatal("running log deleted", err) }
	if _, err := a.DB.Exec(ctx, `INSERT INTO request_logs(user_id,type,status) VALUES($1,'image','succeeded');`, admin); err != nil { t.Fatal(err) }
	if _, err := a.DB.Exec(ctx, `CREATE FUNCTION reject_log_clear_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
		CREATE TRIGGER reject_log_clear_audit BEFORE INSERT ON audit_logs FOR EACH ROW WHEN (NEW.action='request-logs.clear') EXECUTE FUNCTION reject_log_clear_audit()`); err != nil { t.Fatal(err) }
	response = testRequest(a.Router(), "DELETE", "/api/admin/request-logs", Row{"securityProof": securityProof{Password: password}}, cookie)
	if response.Code != 500 { t.Fatalf("audit failure was ignored: %d %s", response.Code, response.Body.String()) }
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM request_logs").Scan(&count); err != nil || count != 2 { t.Fatal("audit failure did not roll back log deletion", err) }
}
