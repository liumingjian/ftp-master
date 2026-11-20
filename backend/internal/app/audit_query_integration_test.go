//go:build integration

package app_test

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"strings"
	"testing"
	"time"
)

func TestAuditQueryAdministratorAndRange(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	b := newBrowser(t, server)
	body := map[string]any{"from": "2026-11-19T00:00:00Z", "to": "2026-11-20T00:00:00Z"}
	if status, _ := b.do("POST", "/api/audit/query", body); status != 401 {
		t.Fatalf("anonymous: %d", status)
	}
	signInAsAdministrator(t, b)
	if status, data := b.do("POST", "/api/audit/query", body); status != 200 {
		t.Fatalf("query: %d %s", status, data)
	}
	body["to"] = "2027-11-20T00:00:00Z"
	if status, _ := b.do("POST", "/api/audit/query", body); status != 400 {
		t.Fatalf("range: %d", status)
	}
}

func TestAuditQueryHistoricalPathsPackedFilesAndCSV(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	admin := newBrowser(t, server)
	signInAsAdministrator(t, admin)
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stores.config.MigrationDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, `INSERT INTO audit_events(occurred_at,user_id,username,action,outcome,item_id,item_path,detail) VALUES
 ('2026-11-19T09:00:00Z',1,'=SUM(1)','rename','success',81,'/Old/a.txt','{}'),
 ('2026-11-19T09:01:00Z',1,'admin','move','success',81,'/New/a.txt','{}'),
 ('2026-11-19T09:02:00Z',1,'admin','zip_download','success',NULL,NULL,'{"files":[{"id":81,"path":"/Old/sub/a.txt"}]}'),
 ('2026-11-19T09:03:00Z',1,'admin','download','failure',82,'/Older/b.txt','{}')`)
	if err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"from": "2026-11-19T00:00:00Z", "to": "2026-11-20T00:00:00Z", "directory": "/Old"}
	query := func(want int) {
		t.Helper()
		status, data := admin.do("POST", "/api/audit/query", body)
		if status != 200 {
			t.Fatalf("query: %d %s", status, data)
		}
		var result struct{ Total int }
		decode(t, data, &result)
		if result.Total != want {
			t.Fatalf("want %d: %s", want, data)
		}
	}
	query(2)
	body["includeSubdirectories"] = false
	query(1)
	delete(body, "directory")
	body["itemId"] = 81
	query(3)
	body["action"] = "move"
	query(1)
	delete(body, "action")
	body["export"] = true
	status, data := admin.do("POST", "/api/audit/query", body)
	if status != 200 || !strings.Contains(string(data), "/Old/a.txt") || !strings.Contains(string(data), "/New/a.txt") || !strings.Contains(string(data), "'=SUM(1)") {
		t.Fatalf("csv: %d %s", status, data)
	}
	delete(body, "export")
	query(3)
	delete(body, "itemId")
	body["failuresOnly"] = true
	query(1)
	_, err = conn.Exec(ctx, `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT 'audit-reader','Reader',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1`)
	if err != nil {
		t.Fatal(err)
	}
	reader := newBrowser(t, server)
	reader.signIn("audit-reader", initialAdministratorPassword)
	if status, _ := reader.do("POST", "/api/audit/query", body); status != 403 {
		t.Fatalf("reader: %d", status)
	}
}

func TestAuditQueryOrganizationDescendantsAndPagination(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	b := newBrowser(t, server)
	signInAsAdministrator(t, b)
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stores.config.MigrationDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var org, child, user int64
	if err := conn.QueryRow(ctx, `INSERT INTO organizations(name) VALUES ('Parent') RETURNING id`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `INSERT INTO organizations(name,parent_id) VALUES ('Child',$1) RETURNING id`, org).Scan(&child); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at,organization_id) SELECT 'child-user','Child',password_hash,false,'active',created_at,$1 FROM users WHERE is_administrator LIMIT 1 RETURNING id`, child).Scan(&user); err != nil {
		t.Fatal(err)
	}
	_, err = conn.Exec(ctx, `INSERT INTO audit_events(occurred_at,user_id,username,action,outcome,item_path) SELECT '2026-11-19T09:00:00Z',$1,'child-user','upload','success','/Dept/a.txt' FROM generate_series(1,51)`, user)
	if err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"from": "2026-11-19T00:00:00Z", "to": "2026-11-20T00:00:00Z", "organizationId": org, "category": "write"}
	read := func(wantTotal, wantRows int) {
		t.Helper()
		status, data := b.do("POST", "/api/audit/query", body)
		if status != 200 {
			t.Fatalf("query %d %s", status, data)
		}
		var result struct {
			Total  int
			Events []struct{ Username string }
		}
		decode(t, data, &result)
		if result.Total != wantTotal || len(result.Events) != wantRows {
			t.Fatalf("result %s", data)
		}
	}
	read(51, 50)
	body["page"] = 2
	read(51, 1)
	body["userIds"] = []int64{1}
	read(0, 0)
	delete(body, "userIds")
	body["category"] = "read"
	read(0, 0)
}
