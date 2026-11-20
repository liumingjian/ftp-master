//go:build integration

package app_test

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"strings"
	"testing"
	"time"
)

func TestBulkImportValidatesWholeFileAndCreatesActiveUsers(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	admin := newBrowser(t, server)
	actor := signInAsAdministrator(t, admin)
	header := "username,display_name,password,organization_id\n"
	bad := header + fmt.Sprintf("new-user,New,password,%d\nADMIN,Duplicate,password,%d\nmissing,,password,999999\n", actor.OrganizationId, actor.OrganizationId)
	status, data := admin.do("POST", "/api/users/import", map[string]string{"csv": bad})
	if status != 422 || !strings.Contains(string(data), `"row":3`) || !strings.Contains(string(data), `"row":4`) {
		t.Fatalf("validation: %d %s", status, data)
	}
	user := newBrowser(t, server)
	if status, _ := user.signIn("new-user", "password"); status != 401 {
		t.Fatalf("partial import: %d", status)
	}
	valid := header + fmt.Sprintf("new-user,New,password,%d\nsecond,Second,password,%d\n", actor.OrganizationId, actor.OrganizationId)
	status, data = admin.do("POST", "/api/users/import", map[string]string{"csv": valid})
	if status != 201 {
		t.Fatalf("import: %d %s", status, data)
	}
	for _, name := range []string{"new-user", "second"} {
		if status, _ := user.signIn(name, "password"); status != 200 {
			t.Fatalf("sign in %s: %d", name, status)
		}
	}
	if status, _ := user.do("POST", "/api/users/import", map[string]string{"csv": valid}); status != 403 {
		t.Fatalf("authorization: %d", status)
	}
	count := 0
	for _, e := range readAuditEvents(t, stores.config.DatabaseURL) {
		if e.Action == "account_import" {
			count++
			if e.Outcome != "success" {
				t.Fatal(e)
			}
		}
	}
	if count != 2 {
		t.Fatalf("import events: %d", count)
	}
}

func TestBulkImportReportsRepeatedUsernamesAndMissingFields(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	admin := newBrowser(t, server)
	actor := signInAsAdministrator(t, admin)
	csv := fmt.Sprintf("username,display_name,password,organization_id\nduplicate,First,password,%d\nDUPLICATE,Second,password,%d\nno-password,Name,,%d\n", actor.OrganizationId, actor.OrganizationId, actor.OrganizationId)
	status, data := admin.do("POST", "/api/users/import", map[string]string{"csv": csv})
	if status != 422 {
		t.Fatalf("validation: %d %s", status, data)
	}
	for _, row := range []string{`"row":2`, `"row":3`, `"row":4`} {
		if !strings.Contains(string(data), row) {
			t.Fatalf("missing row %s: %s", row, data)
		}
	}
	status, data = admin.do("GET", "/api/managed-users", nil)
	if status != 200 || strings.Contains(string(data), "duplicate") || strings.Contains(string(data), "no-password") {
		t.Fatalf("partial import: %d %s", status, data)
	}
	for _, e := range readAuditEvents(t, stores.config.DatabaseURL) {
		if e.Action == "account_import" {
			t.Fatalf("failed import audited as creation: %+v", e)
		}
	}
}

func TestBulkImportRollsBackUsersWhenAuditCannotBeRecorded(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	admin := newBrowser(t, server)
	actor := signInAsAdministrator(t, admin)
	ctx := context.Background()
	owner, err := pgx.Connect(ctx, stores.config.MigrationDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close(ctx)
	if _, err := owner.Exec(ctx, "REVOKE INSERT ON audit_events FROM ftp_master_app"); err != nil {
		t.Fatal(err)
	}
	csv := fmt.Sprintf("username,display_name,password,organization_id\nrollback,Rollback,password,%d\n", actor.OrganizationId)
	status, data := admin.do("POST", "/api/users/import", map[string]string{"csv": csv})
	if status != 500 {
		t.Fatalf("audit failure: %d %s", status, data)
	}
	status, data = admin.do("GET", "/api/managed-users", nil)
	if status != 200 || strings.Contains(string(data), "rollback") {
		t.Fatalf("unrecorded User created: %d %s", status, data)
	}
}
