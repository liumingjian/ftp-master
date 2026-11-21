// Package scheduler runs retention jobs against the application role.
package scheduler

import (
	"context"
	"github.com/jackc/pgx/v5/pgtype"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/recycle"
	"github.com/minio/minio-go/v7"
)

type Jobs struct {
	pool   *pgxpool.Pool
	client *minio.Client
	bucket string
	clock  clock.Clock
}

func New(pool *pgxpool.Pool, client *minio.Client, bucket string, clk clock.Clock) *Jobs {
	return &Jobs{pool, client, bucket, clk}
}

// Run serializes retention and publication through the Shared Tree lock. Storage
// deletion is durably queued in the metadata transaction and retried after it.
func (j *Jobs) Run(ctx context.Context) error {
	tx, err := j.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(725010)"); err != nil {
		return err
	}
	now := j.clock.Now()
	q := sqlcdb.New(tx)
	entries, err := q.ListRecycleEntries(ctx)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.DeletedAt.Time.After(now.Add(-30 * 24 * time.Hour)) {
			if err = recycle.Purge(ctx, q, entry.NodeID); err != nil {
				return err
			}
			if err = audit.NewRecorder(q, j.clock).Record(ctx, audit.Event{Username: "scheduler", Action: "automatic_purge", Outcome: audit.OutcomeSuccess, ItemID: entry.NodeID, ItemPath: entry.OriginalPath}); err != nil {
				return err
			}
		}
	}
	// Expired unused permits no longer pin source bytes. Delivered permits
	// retain base metadata for saving without pinning the source version.
	if err = q.DeleteExpiredOfficePermits(ctx, pgtype.Timestamptz{Time: now, Valid: true}); err != nil {
		return err
	}
	if err = q.PruneFileVersions(ctx); err != nil {
		return err
	}
	if err = q.DateLegacyUploadBatches(ctx, pgtype.Timestamptz{Time: now, Valid: true}); err != nil {
		return err
	}
	if err = q.QueueExpiredUploads(ctx, pgtype.Timestamptz{Time: now, Valid: true}); err != nil {
		return err
	}
	if err = q.DeleteExpiredUploads(ctx, pgtype.Timestamptz{Time: now, Valid: true}); err != nil {
		return err
	}
	if err = q.QueueExpiredBatchVersions(ctx, pgtype.Timestamptz{Time: now, Valid: true}); err != nil {
		return err
	}
	if err = q.DeleteExpiredBatchVersions(ctx, pgtype.Timestamptz{Time: now, Valid: true}); err != nil {
		return err
	}
	expiredNodes, err := q.ListExpiredBatchNodes(ctx, pgtype.Timestamptz{Time: now, Valid: true})
	if err != nil {
		return err
	}
	if err = q.DeleteExpiredBatchVisibility(ctx, expiredNodes); err != nil {
		return err
	}
	if err = q.DeleteExpiredBatches(ctx, pgtype.Timestamptz{Time: now, Valid: true}); err != nil {
		return err
	}
	if err = q.DeleteExpiredBatchTreeNodes(ctx, expiredNodes); err != nil {
		return err
	}
	month := time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
	for _, at := range []time.Time{month, month.AddDate(0, 1, 0)} {
		if _, err = tx.Exec(ctx, "SELECT audit_ensure_partition($1)", at); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, "SELECT audit_retire_partitions($1)", now); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return recycle.Collect(ctx, j.pool, j.client, j.bucket)
}
