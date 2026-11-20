//go:build integration

package app_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/liumingjian/ftp-master/backend/internal/clock"
)

// auditEvent is an Audit Event as an auditor would read it.
type auditEvent struct {
	OccurredAt time.Time
	UserID     *int64
	Username   string
	SourceIP   string
	Action     string
	Outcome    string
}

func TestSignInFailedSignInAndSignOutAreAudited(t *testing.T) {
	stores := startStores(t)
	start := time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)
	clk := clock.NewFake(start)
	server := startService(t, stores.config, clk)
	browser := newBrowser(t, server)

	browser.signIn("nobody", "whatever")
	clk.Advance(time.Minute)
	browser.signIn(initialAdministratorUsername, "wrong")
	clk.Advance(time.Minute)
	administrator := signInAsAdministrator(t, browser)
	clk.Advance(time.Minute)
	if status := browser.signOut(); status != http.StatusNoContent {
		t.Fatalf("sign out: status %d", status)
	}

	administratorID := administrator.Id
	want := []auditEvent{
		{start, nil, "nobody", "127.0.0.1", "sign_in", "failure"},
		{start.Add(time.Minute), &administratorID, initialAdministratorUsername, "127.0.0.1", "sign_in", "failure"},
		{start.Add(2 * time.Minute), &administratorID, initialAdministratorUsername, "127.0.0.1", "sign_in", "success"},
		{start.Add(3 * time.Minute), &administratorID, initialAdministratorUsername, "127.0.0.1", "sign_out", "success"},
	}
	assertAuditEvents(t, stores.config.DatabaseURL, want)
}

func TestBehindTheProxyTheAuditedSourceIPIsTheClient(t *testing.T) {
	stores := startStores(t)
	// The test client connects from loopback; treat that as the proxy.
	stores.config.HTTP.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	start := time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)
	server := startService(t, stores.config, clock.NewFake(start))
	browser := newBrowser(t, server)
	// The client claims 1.2.3.4; the proxy appends the address it saw.
	browser.header = http.Header{"X-Forwarded-For": {"1.2.3.4, 198.51.100.23"}}

	administrator := signInAsAdministrator(t, browser)

	administratorID := administrator.Id
	assertAuditEvents(t, stores.config.DatabaseURL, []auditEvent{
		{start, &administratorID, initialAdministratorUsername, "198.51.100.23", "sign_in", "success"},
	})
}

func TestTheApplicationRoleCannotChangeOrDeleteAuditEvents(t *testing.T) {
	stores := startStores(t)
	start := time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)
	clk := clock.NewFake(start)
	server := startService(t, stores.config, clk)
	browser := newBrowser(t, server)
	browser.signIn(initialAdministratorUsername, "wrong")
	// One more event in a month whose partition is created while running.
	clk.Advance(90 * 24 * time.Hour)
	browser.signIn(initialAdministratorUsername, "wrong")
	before := readAuditEvents(t, stores.config.DatabaseURL)
	if len(before) != 2 {
		t.Fatalf("setup: %d Audit Events, want 2", len(before))
	}

	ctx := context.Background()
	// The role the service connects as.
	conn, err := pgx.Connect(ctx, stores.config.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	statements := []string{
		`UPDATE audit_events SET outcome = 'success'`,
		`DELETE FROM audit_events`,
		`TRUNCATE audit_events`,
	}
	// Partitions cannot be reached directly either: the one prepared at
	// startup, and the one created on demand.
	for _, partition := range []string{"audit_events_2026_11", "audit_events_2027_02"} {
		statements = append(statements,
			`UPDATE `+partition+` SET outcome = 'success'`,
			`DELETE FROM `+partition,
			`TRUNCATE `+partition,
			`DROP TABLE `+partition,
			`ALTER TABLE audit_events DETACH PARTITION `+partition,
			`ALTER TABLE `+partition+` RENAME TO forgotten`,
		)
	}
	for _, statement := range statements {
		_, err := conn.Exec(ctx, statement)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
			t.Errorf("%s: err = %v, want insufficient_privilege (42501)", statement, err)
		}
	}

	after := readAuditEvents(t, stores.config.DatabaseURL)
	if fmt.Sprint(after) != fmt.Sprint(before) {
		t.Errorf("Audit Events changed:\nbefore %v\n after %v", before, after)
	}
}

func TestEventsAreRecordedInMonthsWithoutAPreparedPartition(t *testing.T) {
	stores := startStores(t)
	start := time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)
	clk := clock.NewFake(start)
	server := startService(t, stores.config, clk)
	browser := newBrowser(t, server)

	// Startup prepares this month and next; three months on, nobody has.
	clk.Advance(90 * 24 * time.Hour)
	administrator := signInAsAdministrator(t, browser)

	administratorID := administrator.Id
	assertAuditEvents(t, stores.config.DatabaseURL, []auditEvent{
		{start.Add(90 * 24 * time.Hour), &administratorID, initialAdministratorUsername, "127.0.0.1", "sign_in", "success"},
	})
}

// assertAuditEvents compares every Audit Event, oldest first, with want. It
// reads as the application role, which may select them.
func assertAuditEvents(t *testing.T, databaseURL string, want []auditEvent) {
	t.Helper()
	got := readAuditEvents(t, databaseURL)
	if len(got) != len(want) {
		t.Fatalf("got %d Audit Events, want %d:\n got %+v\nwant %+v", len(got), len(want), got, want)
	}
	for i := range want {
		g, w := got[i], want[i]
		sameUser := (g.UserID == nil) == (w.UserID == nil) && (g.UserID == nil || *g.UserID == *w.UserID)
		if !g.OccurredAt.Equal(w.OccurredAt) || !sameUser || g.Username != w.Username ||
			g.SourceIP != w.SourceIP || g.Action != w.Action || g.Outcome != w.Outcome {
			t.Errorf("Audit Event %d:\n got %s\nwant %s", i, g, w)
		}
	}
}

func readAuditEvents(t *testing.T, databaseURL string) []auditEvent {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	rows, err := conn.Query(ctx, `
		SELECT occurred_at, user_id, username, COALESCE(host(source_ip), ''), action, outcome
		FROM audit_events ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	events, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (auditEvent, error) {
		var e auditEvent
		err := row.Scan(&e.OccurredAt, &e.UserID, &e.Username, &e.SourceIP, &e.Action, &e.Outcome)
		return e, err
	})
	if err != nil {
		t.Fatal(err)
	}
	return events
}

func (e auditEvent) String() string {
	user := "<none>"
	if e.UserID != nil {
		user = fmt.Sprint(*e.UserID)
	}
	return fmt.Sprintf("%s user=%s %q from %s %s %s",
		e.OccurredAt.UTC().Format(time.RFC3339), user, e.Username, e.SourceIP, e.Action, e.Outcome)
}
