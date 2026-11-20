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

// Session is a User's live sign-in session and the token that names it.
type Session struct {
	User  User
	Token string
}

var (
	// ErrInvalidCredentials means the username and password do not identify
	// an active User. Callers must not reveal which part was wrong.
	ErrInvalidCredentials = errors.New("invalid credentials")
	// ErrUnauthenticated means a request carries no live session of an active User.
	ErrUnauthenticated = errors.New("unauthenticated")
)

// status is a User's lifecycle state (users.status: pending, active or
// deactivated or rejected). Only an active User may sign in or keep a session.
type status string

const statusActive status = "active"
const statusPending status = "pending"

// ErrPendingRegistration is disclosed only after the password has verified.
var ErrPendingRegistration = errors.New("registration pending approval")

// failureReason is why a sign-in was refused. It goes into the Audit Event's
// detail only. A verified pending Registration also receives its pending notice.
type failureReason string

const (
	reasonUnknownUser   failureReason = "unknown_user"
	reasonWrongPassword failureReason = "wrong_password"
	reasonNotActive     failureReason = "not_active"
)

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

// SignIn checks the credentials and starts a session. Both outcomes are
// recorded as Audit Events; if the record cannot be written the sign-in fails.
func (s *Service) SignIn(ctx context.Context, username, password string, from netip.Addr) (Session, error) {
	row, err := s.queries.GetUserByUsername(ctx, username)
	found := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Session{}, fmt.Errorf("look up user: %w", err)
	}

	hash := s.decoyHash
	if found {
		hash = row.PasswordHash
	}
	passwordOK := verifyPassword(hash, password)

	lockState := 0
	if found && status(row.Status) == statusActive {
		lockState, err = s.attempt(ctx, row.ID, passwordOK)
		if err != nil {
			return Session{}, err
		}
		if lockState == 1 {
			if err := s.audit.Record(ctx, audit.Event{UserID: row.ID, Username: row.Username, SourceIP: from, Action: "account_lock", Outcome: audit.OutcomeSuccess}); err != nil {
				return Session{}, err
			}
		}
	}
	var reason failureReason
	switch {
	case lockState != 0:
		reason = "locked"
	case !found:
		reason = reasonUnknownUser
	case !passwordOK:
		reason = reasonWrongPassword
	case status(row.Status) != statusActive:
		reason = reasonNotActive
	}
	if reason != "" {
		actor := User{Username: username}
		if found {
			actor = userFromRow(row)
		}
		event := signInEvent(actor, from, audit.OutcomeFailure)
		event.Detail = map[string]any{"reason": reason}
		if err := s.audit.Record(ctx, event); err != nil {
			return Session{}, err
		}
		if found && passwordOK && status(row.Status) == statusPending {
			return Session{}, ErrPendingRegistration
		}
		return Session{}, ErrInvalidCredentials
	}

	user := userFromRow(row)
	token, err := s.sessions.create(ctx, user.ID)
	if err != nil {
		return Session{}, err
	}
	if err := s.audit.Record(ctx, signInEvent(user, from, audit.OutcomeSuccess)); err != nil {
		// An unrecorded sign-in must not be usable.
		if revokeErr := s.sessions.revoke(ctx, token); revokeErr != nil {
			err = errors.Join(err, revokeErr)
		}
		return Session{}, err
	}
	return Session{User: user, Token: token}, nil
}

// Authenticate returns the session token names if it is live and belongs to
// an active User, and extends it. It returns ErrUnauthenticated otherwise.
func (s *Service) Authenticate(ctx context.Context, token string) (Session, error) {
	userID, ok, err := s.sessions.resolve(ctx, token)
	if err != nil {
		return Session{}, err
	}
	if !ok {
		return Session{}, ErrUnauthenticated
	}
	row, err := s.queries.GetUser(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrUnauthenticated
	}
	if err != nil {
		return Session{}, fmt.Errorf("load session user: %w", err)
	}
	if status(row.Status) != statusActive {
		return Session{}, ErrUnauthenticated
	}
	return Session{User: userFromRow(row), Token: token}, nil
}

// SignOut ends session immediately and records it. The session ends first:
// if the record then fails, the caller sees an error, but an unrecorded
// sign-out leaves less exposed than a recorded one that left the session alive.
func (s *Service) SignOut(ctx context.Context, session Session, from netip.Addr) error {
	if err := s.sessions.revoke(ctx, session.Token); err != nil {
		return err
	}
	return s.audit.Record(ctx, audit.Event{
		UserID: session.User.ID, Username: session.User.Username, SourceIP: from,
		Action: audit.ActionSignOut, Outcome: audit.OutcomeSuccess,
	})
}

// signInEvent describes a sign-in attempt by actor; actor.ID is zero for an
// unknown username.
func signInEvent(actor User, from netip.Addr, outcome audit.Outcome) audit.Event {
	return audit.Event{
		UserID: actor.ID, Username: actor.Username, SourceIP: from,
		Action: audit.ActionSignIn, Outcome: outcome,
	}
}

func userFromRow(row sqlcdb.User) User {
	return User{
		ID:              row.ID,
		Username:        row.Username,
		DisplayName:     row.DisplayName,
		IsAdministrator: row.IsAdministrator,
	}
}
