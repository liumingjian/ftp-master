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

func TestAdministratorReshapesOrganizationsAndManagesUserGroups(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	b := newBrowser(t, server)
	user := signInAsAdministrator(t, b)
	call := func(method, path string, body any, want int) []byte {
		t.Helper()
		status, data := b.do(method, "/api"+path, body)
		if status != want {
			t.Fatalf("%s %s: %d, want %d: %s", method, path, status, want, data)
		}
		return data
	}
	var parent, child struct {
		ID int64 `json:"id"`
	}
	decode(t, call("POST", "/organizations", map[string]any{"name": "Engineering"}, 201), &parent)
	decode(t, call("POST", "/organizations", map[string]any{"name": "Platform", "parentId": parent.ID}, 201), &child)
	call("PATCH", fmt.Sprintf("/organizations/%d", parent.ID), map[string]any{"name": "Engineering", "parentId": child.ID}, 409)
	call("DELETE", fmt.Sprintf("/organizations/%d", parent.ID), nil, 409)
	call("PATCH", fmt.Sprintf("/organizations/%d", child.ID), map[string]any{"name": "Infrastructure"}, 200)
	call("DELETE", fmt.Sprintf("/organizations/%d", parent.ID), nil, 204)
	call("DELETE", "/organizations/1", nil, 409)
	var group struct {
		ID int64 `json:"id"`
	}
	decode(t, call("POST", "/user-groups", map[string]any{"name": "Project"}, 201), &group)
	path := fmt.Sprintf("/user-groups/%d/members", group.ID)
	call("PUT", path, map[string]any{"userIds": []int64{user.Id}}, 204)
	var groups []struct {
		ID      int64   `json:"id"`
		UserIDs []int64 `json:"userIds"`
	}
	decode(t, call("GET", "/user-groups", nil, 200), &groups)
	if len(groups) != 1 || len(groups[0].UserIDs) != 1 || groups[0].UserIDs[0] != user.Id {
		t.Fatalf("unexpected membership: %+v", groups)
	}
	call("PUT", path, map[string]any{"userIds": []int64{999999}}, 409)
	decode(t, call("GET", "/user-groups", nil, 200), &groups)
	if len(groups[0].UserIDs) != 1 || groups[0].UserIDs[0] != user.Id {
		t.Fatalf("failed update changed members: %+v", groups)
	}
	call("PUT", path, map[string]any{"userIds": []int64{}}, 204)
	events := readAuditEvents(t, stores.config.DatabaseURL)
	if len(events) != 8 {
		t.Fatalf("got %d audit events, want 8", len(events))
	}
	for _, e := range events[1:] {
		if e.Action != "account_change" || e.Outcome != "success" {
			t.Fatalf("unexpected event: %+v", e)
		}
	}
}

func TestMembershipOperationsRequireAdministrator(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	b := newBrowser(t, server)
	signInAsAdministrator(t, b)
	// Fixture: a normal active User with the same known local password.
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stores.config.MigrationDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT 'ordinary','Ordinary',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1`)
	if err != nil {
		t.Fatal(err)
	}
	ordinary := newBrowser(t, server)
	if status, _ := ordinary.signIn("ordinary", initialAdministratorPassword); status != 200 {
		t.Fatal(status)
	}
	for _, tc := range []struct {
		method, path string
		body         any
	}{
		{"GET", "/organizations", nil}, {"POST", "/organizations", map[string]any{"name": "Denied"}},
		{"PATCH", "/organizations/1", map[string]any{"name": "Denied"}}, {"DELETE", "/organizations/1", nil},
		{"GET", "/user-groups", nil}, {"POST", "/user-groups", map[string]any{"name": "Denied"}},
		{"PUT", "/user-groups/1/members", map[string]any{"userIds": []int64{}}},
	} {
		if status, data := ordinary.do(tc.method, "/api"+tc.path, tc.body); status != 403 {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, status, data)
		}
	}
}
