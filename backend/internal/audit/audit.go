// Package audit records Audit Events. Recorder.Record is the only way the
// service writes one; the table is append-only (migration 00004).
package audit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
)

// Action is what an Audit Event records being done.
type Action string

// Actions recorded so far. A failed sign-in is ActionSignIn with OutcomeFailure.
const (
	ActionSignIn  Action = "sign_in"
	ActionSignOut Action = "sign_out"
)

// Outcome is whether the action succeeded.
type Outcome string

const (
	OutcomeSuccess Outcome = "success"
	OutcomeFailure Outcome = "failure"
)

// Event is one Audit Event as its caller describes it; Record adds the time.
type Event struct {
	// UserID is the acting User, zero when there is none (an unknown username).
	UserID int64
	// Username is the acting User's username at the time, or the username
	// tried in a failed sign-in.
	Username string
	// SourceIP is the client address the request came from; invalid if unknown.
	SourceIP netip.Addr
	Action   Action
	Outcome  Outcome
	// ItemID and ItemPath identify the item acted on and its path at the
	// time; zero and empty for actions on no item.
	ItemID   int64
	ItemPath string
	// Detail holds action-specific facts, such as why a sign-in failed.
	Detail map[string]any
}

// Recorder writes Audit Events, stamped by its Clock.
type Recorder struct {
	queries *sqlcdb.Queries
	clock   clock.Clock
}

// NewRecorder returns a Recorder writing through queries.
func NewRecorder(queries *sqlcdb.Queries, clk clock.Clock) *Recorder {
	return &Recorder{queries: queries, clock: clk}
}

// Record appends e to the audit log at the current time. Callers must treat
// an error as the action not having been recorded.
func (r *Recorder) Record(ctx context.Context, e Event) error {
	detail := e.Detail
	if detail == nil {
		detail = map[string]any{}
	}
	detailJSON, err := json.Marshal(detail)
	if err != nil {
		return fmt.Errorf("encode audit detail: %w", err)
	}
	now := r.clock.Now()
	params := sqlcdb.InsertAuditEventParams{
		OccurredAt: pgtype.Timestamptz{Time: now, Valid: true},
		UserID:     pgtype.Int8{Int64: e.UserID, Valid: e.UserID != 0},
		Username:   e.Username,
		Action:     string(e.Action),
		Outcome:    string(e.Outcome),
		ItemID:     pgtype.Int8{Int64: e.ItemID, Valid: e.ItemID != 0},
		ItemPath:   pgtype.Text{String: e.ItemPath, Valid: e.ItemPath != ""},
		Detail:     detailJSON,
	}
	if e.SourceIP.IsValid() {
		ip := e.SourceIP.Unmap()
		params.SourceIp = &ip
	}

	err = r.queries.InsertAuditEvent(ctx, params)
	if isMissingPartition(err) {
		// First event of a month nobody prepared a partition for.
		if err := r.EnsurePartition(ctx, now); err != nil {
			return err
		}
		err = r.queries.InsertAuditEvent(ctx, params)
	}
	if err != nil {
		return fmt.Errorf("record audit event %s: %w", e.Action, err)
	}
	return nil
}

// EnsurePartition creates the month partition holding time at, if missing.
func (r *Recorder) EnsurePartition(ctx context.Context, at time.Time) error {
	if err := r.queries.EnsureAuditPartition(ctx, pgtype.Timestamptz{Time: at, Valid: true}); err != nil {
		return fmt.Errorf("create audit partition for %s: %w", at.UTC().Format("2006-01"), err)
	}
	return nil
}

// isMissingPartition reports whether err is PostgreSQL refusing a row because
// no partition covers it.
func isMissingPartition(err error) bool {
	var pgErr *pgconn.PgError
	// check_violation is also raised by the outcome CHECK; only the partition
	// routing failure names no constraint.
	return errors.As(err, &pgErr) && pgErr.Code == "23514" && pgErr.ConstraintName == ""
}
