//go:build integration

package app_test

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"testing"
	"time"
)

func TestSharedTreeCreatesAndListsStableDirectories(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	b := newBrowser(t, server)
	signInAsAdministrator(t, b)
	status, data := b.do("POST", "/api/tree", map[string]any{"name": "Projects"})
	if status != 201 {
		t.Fatalf("create: %d %s", status, data)
	}
	var node struct {
		ID int64 `json:"id"`
	}
	decode(t, data, &node)
	if node.ID <= 0 {
		t.Fatal("missing stable id")
	}
	status, data = b.do("GET", "/api/tree", nil)
	if status != 200 {
		t.Fatalf("list: %d %s", status, data)
	}
	var nodes []struct {
		ID int64 `json:"id"`
	}
	decode(t, data, &nodes)
	if len(nodes) != 1 || nodes[0].ID != node.ID {
		t.Fatalf("unexpected listing %s", data)
	}
}

func TestSharedTreeFiltersTraversalAndDropBoxAndAuditsGrants(t *testing.T) {
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
	var userID int64
	err = conn.QueryRow(ctx, `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT 'reader','Reader',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`).Scan(&userID)
	if err != nil {
		t.Fatal(err)
	}
	reader := newBrowser(t, server)
	if status, _ := reader.signIn("reader", initialAdministratorPassword); status != 200 {
		t.Fatal(status)
	}
	call := func(b *browser, method, path string, body any, want int) []byte {
		t.Helper()
		status, data := b.do(method, "/api"+path, body)
		if status != want {
			t.Fatalf("%s %s: %d want %d: %s", method, path, status, want, data)
		}
		return data
	}
	create := func(name string, parent int64) int64 {
		t.Helper()
		body := map[string]any{"name": name}
		if parent != 0 {
			body["parentId"] = parent
		}
		var n struct {
			ID int64 `json:"id"`
		}
		decode(t, call(admin, "POST", "/tree", body, 201), &n)
		return n.ID
	}
	root := create("Root", 0)
	deep := create("Deep", root)
	hidden := create("Secret", root)
	box := create("Drop Box", root)
	private := create("Private contents", box)
	call(reader, "POST", "/tree", map[string]any{"name": "denied"}, 403)
	call(reader, "GET", fmt.Sprintf("/tree/%d", deep), nil, 404)
	grant := func(id int64, kind string, principal int64, rights int) {
		call(admin, "POST", fmt.Sprintf("/tree/%d/grants", id), map[string]any{"principalKind": kind, "principalId": principal, "rights": rights, "scope": "subtree"}, 201)
	}
	grant(deep, "user", userID, 1)
	grant(box, "user", userID, 4)
	var list []struct {
		ID int64 `json:"id"`
	}
	decode(t, call(reader, "GET", "/tree", nil, 200), &list)
	if len(list) != 1 || list[0].ID != root {
		t.Fatalf("root listing %v", list)
	}
	decode(t, call(reader, "GET", fmt.Sprintf("/tree?parentId=%d", root), nil, 200), &list)
	if len(list) != 2 {
		t.Fatalf("traversal listing %v", list)
	}
	for _, n := range list {
		if n.ID == hidden {
			t.Fatal("sibling leaked")
		}
	}
	decode(t, call(reader, "GET", fmt.Sprintf("/tree?parentId=%d", box), nil, 200), &list)
	if len(list) != 0 {
		t.Fatal("Drop Box leaked contents")
	}
	call(reader, "GET", fmt.Sprintf("/tree/%d", private), nil, 404)
	call(reader, "POST", "/tree", map[string]any{"name": "Allowed submission directory", "parentId": box}, 201)
	call(reader, "POST", "/tree", map[string]any{"name": "denied", "parentId": deep}, 403)
	call(reader, "POST", "/tree", map[string]any{"name": "denied", "parentId": hidden}, 404)
	before := len(readAuditEvents(t, stores.config.DatabaseURL))
	call(reader, "GET", "/tree", nil, 200)
	if len(readAuditEvents(t, stores.config.DatabaseURL)) != before {
		t.Fatal("browsing audited")
	}
	events := readAuditEvents(t, stores.config.DatabaseURL)
	count := 0
	for _, e := range events {
		if e.Action == "grant_change" {
			count++
		}
	}
	if count != 2 {
		t.Fatalf("Grant events: %d", count)
	}
	var group struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/user-groups", map[string]any{"name": "Readers"}, 201), &group)
	call(admin, "PUT", fmt.Sprintf("/user-groups/%d/members", group.ID), map[string]any{"userIds": []int64{userID}}, 204)
	grant(deep, "user_group", group.ID, 4)
	var node struct {
		Rights int `json:"rights"`
	}
	decode(t, call(reader, "GET", fmt.Sprintf("/tree/%d", deep), nil, 200), &node)
	if node.Rights != 5 {
		t.Fatalf("union: %d", node.Rights)
	}
	var org struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "Child", "parentId": 1}, 201), &org)
	_, err = conn.Exec(ctx, "UPDATE users SET organization_id=$1 WHERE id=$2", org.ID, userID)
	if err != nil {
		t.Fatal(err)
	}
	grant(hidden, "organization", 1, 1)
	call(reader, "GET", fmt.Sprintf("/tree/%d", hidden), nil, 200)
}

func TestGrantDraftAtomicSaveAndInheritedSources(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	b := newBrowser(t, server)
	signInAsAdministrator(t, b)
	status, data := b.do("POST", "/api/tree", map[string]any{"name": "Draft root"})
	if status != 201 {
		t.Fatal(status, string(data))
	}
	var n struct {
		ID int64 `json:"id"`
	}
	decode(t, data, &n)
	path := fmt.Sprintf("/api/tree/%d/grant-draft", n.ID)
	status, data = b.do("GET", path, nil)
	if status != 200 {
		t.Fatal(status, string(data))
	}
	// Invalid second principal must roll back the first creation and its audit.
	before := len(readAuditEvents(t, stores.config.DatabaseURL))
	status, data = b.do("POST", path, map[string]any{"add": []any{map[string]any{"principalKind": "user", "principalId": 1, "rights": 1, "scope": "subtree"}, map[string]any{"principalKind": "user", "principalId": 999999, "rights": 1, "scope": "subtree"}}, "remove": []int64{}})
	if status != 400 {
		t.Fatal(status, string(data))
	}
	status, data = b.do("GET", path, nil)
	var grants []any
	decode(t, data, &grants)
	if status != 200 || len(grants) != 0 {
		t.Fatal(status, string(data))
	}
	if len(readAuditEvents(t, stores.config.DatabaseURL)) != before {
		t.Fatal("failed draft audited")
	}
}

func TestGrantDraftDelegationAndScope(t *testing.T) {
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
	var uid int64
	err = conn.QueryRow(ctx, `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT 'delegate','Delegate',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`).Scan(&uid)
	if err != nil {
		t.Fatal(err)
	}
	delegated := newBrowser(t, server)
	if status, _ := delegated.signIn("delegate", initialAdministratorPassword); status != 200 {
		t.Fatal(status)
	}
	call := func(b *browser, method, path string, body any, want int) []byte {
		t.Helper()
		status, data := b.do(method, path, body)
		if status != want {
			t.Fatalf("%s %s: %d want %d %s", method, path, status, want, data)
		}
		return data
	}
	var root, child struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/api/tree", map[string]any{"name": "Area"}, 201), &root)
	decode(t, call(admin, "POST", "/api/tree", map[string]any{"name": "Child", "parentId": root.ID}, 201), &child)
	grant := map[string]any{"principalKind": "user", "principalId": uid, "rights": 63, "scope": "this_level_only"}
	call(admin, "POST", fmt.Sprintf("/api/tree/%d/grants", root.ID), grant, 201)
	path := fmt.Sprintf("/api/tree/%d/grant-draft", root.ID)
	call(delegated, "GET", path, nil, 200)
	call(delegated, "GET", fmt.Sprintf("/api/tree/%d/grant-draft", child.ID), nil, 404)
	grant["scope"] = "subtree"
	call(delegated, "POST", path, map[string]any{"add": []any{grant}, "remove": []int64{}}, 403)
	grant["scope"] = "this_level_only"
	grant["rights"] = 8
	call(delegated, "POST", path, map[string]any{"add": []any{grant}, "remove": []int64{}}, 204)
	var sources []struct {
		Grant struct {
			Rights int `json:"rights"`
		}
		Inherited  bool   `json:"inherited"`
		SourcePath string `json:"sourcePath"`
	}
	decode(t, call(admin, "GET", path, nil, 200), &sources)
	if len(sources) != 2 || sources[1].Grant.Rights != 11 {
		t.Fatalf("coherent saved Rights: %+v", sources)
	}
	grant["scope"] = "subtree"
	call(admin, "POST", fmt.Sprintf("/api/tree/%d/grants", root.ID), grant, 201)
	decode(t, call(admin, "GET", fmt.Sprintf("/api/tree/%d/grant-draft", child.ID), nil, 200), &sources)
	if len(sources) != 1 || !sources[0].Inherited || sources[0].SourcePath != "/Area" {
		t.Fatalf("inheritance: %+v", sources)
	}
}
