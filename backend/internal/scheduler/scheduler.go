// Package scheduler runs retention jobs against the application role.
package scheduler

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
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
	nowTS := pgtype.Timestamptz{Time: now, Valid: true}
	q := sqlcdb.New(tx)
	recorder := audit.NewRecorder(q, j.clock)
	entries, err := q.ListRecycleEntries(ctx)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.DeletedAt.Time.After(now.Add(-30 * 24 * time.Hour)) {
			if err = recycle.Purge(ctx, q, entry.NodeID); err != nil {
				return err
			}
			if err = recorder.Record(ctx, audit.Event{Username: "scheduler", Action: "automatic_purge", Outcome: audit.OutcomeSuccess, ItemID: entry.NodeID, ItemPath: entry.OriginalPath}); err != nil {
				return err
			}
		}
	}
	// Expired unused permits no longer pin source bytes. Delivered permits
	// retain base metadata for saving without pinning the source version.
	if err = q.DeleteExpiredOfficePermits(ctx, nowTS); err != nil {
		return err
	}
	if err = q.PruneFileVersions(ctx); err != nil {
		return err
	}
	if err = q.DateLegacyUploadBatches(ctx, nowTS); err != nil {
		return err
	}
	// Audit expired incomplete uploads that already transferred >0 bytes (ADR 0009).
	abandoned, err := q.ListExpiredUploadsForAudit(ctx, nowTS)
	if err != nil {
		return err
	}
	for _, u := range abandoned {
		sampleRows, err := q.ListUploadTransferSamples(ctx, u.ID)
		if err != nil {
			return err
		}
		segments := make([]audit.TransferSegment, 0, len(sampleRows))
		for _, row := range sampleRows {
			decoded, decErr := audit.DecodeRawSamples(row.Samples)
			if decErr != nil {
				return decErr
			}
			segments = append(segments, audit.TransferSegment{
				StartedAt:        row.StartedAt.Time,
				EndedAt:          row.EndedAt.Time,
				BytesTransferred: row.BytesTransferred,
				Samples:          decoded,
			})
		}
		reason := "会话过期未续传（已放弃）"
		summary, series := audit.BuildTransferProfile(segments, u.Size, true, reason, nil)
		itemPath := "/" + u.Name
		if u.RelativePath != "" {
			itemPath = "/" + u.RelativePath
		}
		if err = recorder.Record(ctx, audit.Event{
			UserID:   u.OwnerID,
			Username: u.Username,
			Action:   "upload",
			Outcome:  audit.OutcomeFailure,
			ItemPath: itemPath,
			Detail: map[string]any{
				"reason":          reason,
				"size":            u.Size,
				"transferProfile": summary,
			},
			TransferSeries: series,
		}); err != nil {
			return err
		}
	}
	if err = q.QueueExpiredUploads(ctx, nowTS); err != nil {
		return err
	}
	if err = q.DeleteExpiredUploads(ctx, nowTS); err != nil {
		return err
	}
	if err = q.QueueExpiredBatchVersions(ctx, nowTS); err != nil {
		return err
	}
	if err = q.DeleteExpiredBatchVersions(ctx, nowTS); err != nil {
		return err
	}
	expiredNodes, err := q.ListExpiredBatchNodes(ctx, nowTS)
	if err != nil {
		return err
	}
	if err = q.DeleteExpiredBatchVisibility(ctx, expiredNodes); err != nil {
		return err
	}
	if err = q.DeleteExpiredBatches(ctx, nowTS); err != nil {
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
