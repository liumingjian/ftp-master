package identity

import (
	"context"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
)

// Register reserves a username and stores a hashed password pending approval.
func (s *Service) Register(ctx context.Context, username, name, hint, password string) error {
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	_, err = s.queries.CreateRegistration(ctx, sqlcdb.CreateRegistrationParams{Username: username, DisplayName: name, OrganizationHint: hint, PasswordHash: hash, CreatedAt: pgtype.Timestamptz{Time: s.clock.Now(), Valid: true}})
	return err
}
