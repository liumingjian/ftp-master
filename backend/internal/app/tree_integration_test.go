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
