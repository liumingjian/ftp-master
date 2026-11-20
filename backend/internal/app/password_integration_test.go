//go:build integration

package app_test

import (
	"context"
	"github.com/jackc/pgx/v5"

	"fmt"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"net/http"
	"testing"
	"time"
)

func TestLockoutExpiresAndSuccessfulSignInResetsFailures(t *testing.T) {
	stores := startStores(t)
	clk := clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC))
	server := startService(t, stores.config, clk)
	b := newBrowser(t, server)
	for i := 0; i < 4; i++ {
		b.signIn(initialAdministratorUsername, "wrong")
	}
	signInAsAdministrator(t, b)
	for i := 0; i < 5; i++ {
		b.signIn(initialAdministratorUsername, "wrong")
	}
	if status, _ := b.signIn(initialAdministratorUsername, initialAdministratorPassword); status != http.StatusUnauthorized {
		t.Fatalf("locked sign-in: %d", status)
	}
	clk.Advance(15*time.Minute - time.Second)
	if status, _ := b.signIn(initialAdministratorUsername, initialAdministratorPassword); status != 401 {
		t.Fatalf("early unlock: %d", status)
	}
	clk.Advance(time.Second)
	signInAsAdministrator(t, b)
	count := 0
	for _, e := range readAuditEvents(t, stores.config.DatabaseURL) {
		if e.Action == "account_lock" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("lock events: %d", count)
	}
}

func TestPasswordChangeAndAdministratorReset(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	b := newBrowser(t, server)
	u := signInAsAdministrator(t, b)
	path := "/api/password"
	if status, _ := b.do("PUT", path, map[string]string{"currentPassword": "wrong", "newPassword": "changed"}); status != 403 {
		t.Fatalf("wrong current password: %d", status)
	}
	if status, _ := b.do("PUT", path, map[string]string{"currentPassword": initialAdministratorPassword, "newPassword": "changed"}); status != 204 {
		t.Fatalf("change password: %d", status)
	}
	if status, _ := newBrowser(t, server).signIn(initialAdministratorUsername, initialAdministratorPassword); status != 401 {
		t.Fatalf("old password: %d", status)
	}
	if status, _ := newBrowser(t, server).signIn(initialAdministratorUsername, "changed"); status != 200 {
		t.Fatalf("new password: %d", status)
	}
	if status, _ := b.do("PUT", fmt.Sprintf("/api/users/%d/password", u.Id), map[string]string{"newPassword": "reset"}); status != 204 {
		t.Fatalf("reset: %d", status)
	}
	if status, _ := newBrowser(t, server).signIn(initialAdministratorUsername, "reset"); status != 200 {
		t.Fatalf("reset sign-in: %d", status)
	}
	actions := map[string]int{}
	for _, e := range readAuditEvents(t, stores.config.DatabaseURL) {
		actions[e.Action]++
	}
	if actions["password_change"] != 1 || actions["password_reset"] != 1 {
		t.Fatalf("audit actions: %v", actions)
	}
}

func TestOnlyAdministratorCanResetPasswords(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	b := newBrowser(t, server)
	u := signInAsAdministrator(t, b)
	conn, err := pgx.Connect(context.Background(), stores.config.MigrationDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	if _, err := conn.Exec(context.Background(), "UPDATE users SET is_administrator=false WHERE id=$1", u.Id); err != nil {
		t.Fatal(err)
	}
	if status, _ := b.do("PUT", fmt.Sprintf("/api/users/%d/password", u.Id), map[string]string{"newPassword": "forbidden"}); status != 403 {
		t.Fatalf("non-Administrator reset: %d", status)
	}
	if status, _ := b.do("PUT", "/api/password", map[string]string{"currentPassword": initialAdministratorPassword, "newPassword": ""}); status != 400 {
		t.Fatalf("empty password: %d", status)
	}
	if status, _ := b.signIn(initialAdministratorUsername, initialAdministratorPassword); status != 200 {
		t.Fatalf("password changed after refusal: %d", status)
	}
	for _, e := range readAuditEvents(t, stores.config.DatabaseURL) {
		if e.Action == "password_reset" || e.Action == "password_change" {
			t.Fatalf("refused action recorded as success: %v", e)
		}
	}
}
