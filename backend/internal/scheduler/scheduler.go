// Package scheduler runs retention jobs against the application role.
package scheduler

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/recycle"
	"github.com/minio/minio-go/v7"
	"strings"
	"time"
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
	// Expired edit permits no longer pin source versions. Active edits keep their
	// immutable source until their permit expires, then the next run prunes it.
	statements := []string{
		`DELETE FROM office_edit_permits WHERE expires_at <= $1`,
		`WITH ranked AS (SELECT id,object_key,row_number() OVER(PARTITION BY file_id ORDER BY id DESC) n FROM file_versions), removed AS (DELETE FROM file_versions f USING ranked r WHERE f.id=r.id AND r.n>20 AND NOT EXISTS(SELECT 1 FROM office_edit_permits p WHERE p.version_id=f.id) RETURNING f.object_key) INSERT INTO storage_gc(object_key) SELECT object_key FROM removed ON CONFLICT DO NOTHING`,
		`UPDATE upload_batches SET created_at=$1 WHERE created_at IS NULL`,
		// Mark every old hidden batch as one expired unit, including complete children.
		`INSERT INTO storage_gc(object_key,upload_id) SELECT u.object_key,u.storage_upload_id FROM upload_sessions u LEFT JOIN upload_batches b ON b.id=u.batch_id WHERE (u.state<>'complete' AND u.created_at <= $1::timestamptz-interval '24 hours') OR b.created_at <= $1::timestamptz-interval '24 hours' ON CONFLICT DO NOTHING`,
		`DELETE FROM upload_sessions u WHERE (u.state<>'complete' AND u.created_at <= $1::timestamptz-interval '24 hours') OR batch_id IN(SELECT id FROM upload_batches WHERE created_at <= $1::timestamptz-interval '24 hours')`,
		`INSERT INTO storage_gc(object_key) SELECT v.object_key FROM file_versions v JOIN upload_batch_nodes n ON n.node_id=v.file_id JOIN upload_batches b ON b.id=n.batch_id WHERE b.created_at <= $1::timestamptz-interval '24 hours' ON CONFLICT DO NOTHING`,
		`DELETE FROM file_versions WHERE file_id IN(SELECT n.node_id FROM upload_batch_nodes n JOIN upload_batches b ON b.id=n.batch_id WHERE b.created_at <= $1::timestamptz-interval '24 hours')`,
		// Save node identities while removing batch FK references before tree nodes.
		`CREATE TEMP TABLE expired_batch_nodes ON COMMIT DROP AS SELECT n.node_id FROM upload_batch_nodes n JOIN upload_batches b ON b.id=n.batch_id WHERE b.created_at <= $1::timestamptz-interval '24 hours'`,
		`DELETE FROM upload_batch_nodes WHERE node_id IN(SELECT node_id FROM expired_batch_nodes)`,
		`DELETE FROM upload_batches WHERE created_at <= $1::timestamptz-interval '24 hours'`,
		`DELETE FROM tree_nodes WHERE id IN(SELECT node_id FROM expired_batch_nodes)`,
	}
	for _, sql := range statements { // Only statements with $1 accept the Clock parameter.
		if strings.Contains(sql, "$1") {
			_, err = tx.Exec(ctx, sql, now)
		} else {
			_, err = tx.Exec(ctx, sql)
		}
		if err != nil {
			return err
		}
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
