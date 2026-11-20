package identity

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"net/netip"
)

var ErrForbidden = errors.New("forbidden")
var ErrUserNotFound = errors.New("user not found")

// ChangePassword atomically updates the credential and its Audit Event.
// The expected hash prevents concurrent changes from silently overwriting one another.
func (s *Service) ChangePassword(ctx context.Context, actor User, targetID int64, current, next string, reset bool, from netip.Addr) error {
	if reset && !actor.IsAdministrator {
		return ErrForbidden
	}
	row, err := s.queries.GetUser(ctx, targetID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrUserNotFound
	}
	if err != nil {
		return err
	}
	if !reset && (targetID != actor.ID || !verifyPassword(row.PasswordHash, current)) {
		return ErrForbidden
	}
	hash, err := hashPassword(next)
	if err != nil {
		return err
	}
	if err := s.audit.EnsurePartition(ctx, s.clock.Now()); err != nil {
		return err
	}
	action := "password_change"
	if reset {
		action = "password_reset"
	}
	var ip *netip.Addr
	if from.IsValid() {
		ip = &from
	}
	n, err := s.queries.ChangePasswordWithAudit(ctx, sqlcdb.ChangePasswordWithAuditParams{
		OccurredAt: pgtype.Timestamptz{Time: s.clock.Now(), Valid: true}, ActorID: pgtype.Int8{Int64: actor.ID, Valid: true}, ActorName: actor.Username, SourceIp: ip, Action: action, NewHash: hash, TargetID: targetID, ExpectedHash: row.PasswordHash,
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrForbidden
	}
	return nil
}
