package db

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// PostgreSQL transaction-scoped advisory lock keys.
//
// Canonical lock order when one transaction needs both locks:
//
//	LockMembership (725005) BEFORE LockSharedTree (725010)
//
// Always acquire locks via the helpers below rather than raw SQL so lock keys
// and ordering stay uniform across handlers, recycle, and scheduler passes.
const (
	LockMembership      int64 = 725005
	LockSharedTree      int64 = 725010
	LockAuditPartitions int64 = 725011
)

// LockMembershipTx acquires the membership and Storage Quota advisory lock inside tx.
func LockMembershipTx(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", LockMembership)
	return err
}

// LockSharedTreeTx acquires the Shared Tree and storage mutation advisory lock inside tx.
func LockSharedTreeTx(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", LockSharedTree)
	return err
}

// LockMembershipAndSharedTreeTx acquires LockMembership (725005) before
// LockSharedTree (725010) inside tx to prevent cross-handler deadlocks.
func LockMembershipAndSharedTreeTx(ctx context.Context, tx pgx.Tx) error {
	if err := LockMembershipTx(ctx, tx); err != nil {
		return err
	}
	return LockSharedTreeTx(ctx, tx)
}
