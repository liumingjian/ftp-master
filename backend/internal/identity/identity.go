// Package identity signs Users in and out and authenticates their requests.
package identity

import (
	"context"
	"errors"
	"fmt"
	"net/netip"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/redis/go-redis/v9"

	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
)

// User is a signed-in, active User.
type User struct {
	ID              int64
	Username        string
	DisplayName     string
	IsAdministrator bool
}

var (
	// ErrInvalidCredentials means the username and password do not identify
	// an active User. Callers must not reveal which part was wrong.
	ErrInvalidCredentials = errors.New("invalid credentials")
	// ErrUnauthenticated means a request carries no live session of an active User.
	ErrUnauthenticated = errors.New("unauthenticated")
)

const statusActive = "active"

// Service signs Users in and out and authenticates sessions.
type Service struct {
	queries  *sqlcdb.Queries
	sessions *sessions
	audit    *audit.Recorder
	clock    clock.Clock
	// decoyHash is verified against when the username is unknown, so a
	// refusal takes as long either way and does not reveal which usernames exist.
	decoyHash string
}

// NewService returns a Service storing Users in PostgreSQL through queries and
// sessions in Redis.
func NewService(queries *sqlcdb.Queries, redisClient *redis.Client, recorder *audit.Recorder, clk clock.Clock) (*Service, error) {
	decoy, err := hashPassword("decoy")
	if err != nil {
		return nil, err
	}
	return &Service{
		queries:   queries,
		sessions:  &sessions{redis: redisClient, clock: clk},
		audit:     recorder,
		clock:     clk,
		decoyHash: decoy,
	}, nil
}

// EnsureInitialAdministrator creates an active Administrator with the given
// credentials if no Administrator exists yet, so a fresh installation can be
// signed into. It does nothing once there is one.
func (s *Service) EnsureInitialAdministrator(ctx context.Context, username, password string) error {
	if username == "" || password == "" {
		return nil
	}
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	_, err = s.queries.CreateInitialAdministrator(ctx, sqlcdb.CreateInitialAdministratorParams{
		Username:     username,
		DisplayName:  username,
		PasswordHash: hash,
		CreatedAt:    pgtype.Timestamptz{Time: s.clock.Now(), Valid: true},
	})
	if err != nil {
		return fmt.Errorf("create initial Administrator: %w", err)
	}
	return nil
}

// SignIn checks the credentials and starts a session, returning its token.
// Both outcomes are recorded as Audit Events; if the record cannot be written
// the sign-in fails.
func (s *Service) SignIn(ctx context.Context, username, password string, from netip.Addr) (User, string, error) {
	row, err := s.queries.GetUserByUsername(ctx, username)
	found := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return User{}, "", fmt.Errorf("look up user: %w", err)
	}

	hash := s.decoyHash
	if found {
		hash = row.PasswordHash
	}
	passwordOK := verifyPassword(hash, password)

	var reason string
	switch {
	case !found:
		reason = "unknown_user"
	case !passwordOK:
		reason = "wrong_password"
	case row.Status != statusActive:
		reason = "not_active"
	}
	if reason != "" {
		event := audit.Event{
			Username: username, SourceIP: from,
			Action: audit.ActionSignIn, Outcome: audit.OutcomeFailure,
			Detail: map[string]any{"reason": reason},
		}
		if found {
			event.UserID, event.Username = row.ID, row.Username
		}
		if err := s.audit.Record(ctx, event); err != nil {
			return User{}, "", err
		}
		return User{}, "", ErrInvalidCredentials
	}

	token, err := s.sessions.create(ctx, row.ID)
	if err != nil {
		return User{}, "", err
	}
	err = s.audit.Record(ctx, audit.Event{
		UserID: row.ID, Username: row.Username, SourceIP: from,
		Action: audit.ActionSignIn, Outcome: audit.OutcomeSuccess,
	})
	if err != nil {
		// An unrecorded sign-in must not be usable.
		if revokeErr := s.sessions.revoke(ctx, token); revokeErr != nil {
			err = errors.Join(err, revokeErr)
		}
		return User{}, "", err
	}
	return userFromRow(row), token, nil
}

// Authenticate returns the active User whose live session token is, and
// extends the session. It returns ErrUnauthenticated otherwise.
func (s *Service) Authenticate(ctx context.Context, token string) (User, error) {
	userID, ok, err := s.sessions.resolve(ctx, token)
	if err != nil {
		return User{}, err
	}
	if !ok {
		return User{}, ErrUnauthenticated
	}
	row, err := s.queries.GetUser(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUnauthenticated
	}
	if err != nil {
		return User{}, fmt.Errorf("load session user: %w", err)
	}
	if row.Status != statusActive {
		return User{}, ErrUnauthenticated
	}
	return userFromRow(row), nil
}

// SignOut ends user's session token immediately and records it. The session
// ends first: if the record then fails, the caller sees an error, but an
// unrecorded sign-out leaves less exposed than a recorded one that left the
// session alive.
func (s *Service) SignOut(ctx context.Context, user User, token string, from netip.Addr) error {
	if err := s.sessions.revoke(ctx, token); err != nil {
		return err
	}
	return s.audit.Record(ctx, audit.Event{
		UserID: user.ID, Username: user.Username, SourceIP: from,
		Action: audit.ActionSignOut, Outcome: audit.OutcomeSuccess,
	})
}

func userFromRow(row sqlcdb.User) User {
	return User{
		ID:              row.ID,
		Username:        row.Username,
		DisplayName:     row.DisplayName,
		IsAdministrator: row.IsAdministrator,
	}
}
