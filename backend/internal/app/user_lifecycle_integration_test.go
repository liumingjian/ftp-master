//go:build integration

package app_test

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"testing"
	"time"
)

func TestDeactivationPermanentlyRevokesSessionsAndMoveIsImmediate(t *testing.T) {
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
	var id int64
	err = conn.QueryRow(ctx, `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT 'lifecycle','Lifecycle',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	first, second := newBrowser(t, server), newBrowser(t, server)
	for _, b := range []*browser{first, second} {
		if status, _ := b.signIn("lifecycle", initialAdministratorPassword); status != 200 {
			t.Fatal(status)
		}
	}
	path := fmt.Sprintf("/api/users/%d", id)
	call := func(method, path string, body any, want int) []byte {
		t.Helper()
		status, data := admin.do(method, path, body)
		if status != want {
			t.Fatalf("%s: %d want %d: %s", path, status, want, data)
		}
		return data
	}
	call("PATCH", path+"/status", map[string]any{"status": "deactivated"}, 204)
	if status, _ := first.do("GET", "/api/session", nil); status != 401 {
		t.Fatal(status)
	}
	call("PATCH", path+"/status", map[string]any{"status": "active"}, 204)
	if status, _ := second.do("GET", "/api/session", nil); status != 401 {
		t.Fatalf("old session revived: %d", status)
	}
	if status, _ := first.signIn("lifecycle", initialAdministratorPassword); status != 200 {
		t.Fatal(status)
	}
	var org struct {
		ID int64 `json:"id"`
	}
	decode(t, call("POST", "/api/organizations", map[string]any{"name": "New team"}, 201), &org)
	call("PUT", path+"/organization", map[string]any{"organizationId": org.ID}, 204)
	var current struct {
		OrganizationID int64 `json:"organizationId"`
	}
	status, data := first.do("GET", "/api/session", nil)
	if status != 200 {
		t.Fatal(status)
	}
	decode(t, data, &current)
	if current.OrganizationID != org.ID {
		t.Fatalf("organization = %d", current.OrganizationID)
	}
	if status, _ := first.do("PATCH", path+"/status", map[string]any{"status": "deactivated"}); status != 403 {
		t.Fatal(status)
	}
	events := readAuditEvents(t, stores.config.DatabaseURL)
	operations := 0
	for _, e := range events {
		if e.Action == "account_change" {
			operations++
			if e.Outcome != "success" {
				t.Fatalf("unexpected audit outcome: %+v", e)
			}
		}
	}
	if operations != 4 {
		t.Fatalf("expected four distinct membership audit events: %+v", events)
	}
	rows, err := conn.Query(ctx, `SELECT detail FROM audit_events WHERE action='account_change' ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var details []map[string]any
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var d map[string]any
		if err := json.Unmarshal(raw, &d); err != nil {
			t.Fatal(err)
		}
		details = append(details, d)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if details[0]["operation"] != "set_user_status" || details[0]["result"].(map[string]any)["status"] != "deactivated" || details[1]["result"].(map[string]any)["status"] != "active" || details[3]["operation"] != "move_user" {
		t.Fatalf("unexpected audit details: %+v", details)
	}

}
