// Package recycle provides transactional metadata purge and retryable storage collection.
package recycle

import (
	"context"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/liumingjian/ftp-master/backend/internal/db"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/minio/minio-go/v7"
)

// Purge runs inside the caller's tree-locked transaction; audit must share it.
func Purge(ctx context.Context, q *sqlcdb.Queries, id int64) error {
	root := pgtype.Int8{Int64: id, Valid: true}
	for _, step := range []func() error{
		func() error { return q.QueueRecycleObjects(ctx, root) },
		func() error { return q.QueueRecycleUploads(ctx, root) },
		func() error { return q.DeleteRecyclePermits(ctx, root) },
		func() error { return q.DeleteRecycleUploads(ctx, root) },
		func() error { return q.DeleteRecycleVersions(ctx, root) },
		func() error { return q.DeleteRecycleEntry(ctx, id) },
		func() error { return q.PurgeRecycleNodes(ctx, root) },
	} {
		if err := step(); err != nil {
			return err
		}
	}
	return nil
}

// Collect removes only unreferenced immutable objects. The same lock as publication
// prevents a new reference from appearing between the check and object removal.
// Failed removals retain their queue rows; repeated removals are idempotent.
func Collect(ctx context.Context, pool *pgxpool.Pool, client *minio.Client, bucket string) error {
	if client == nil {
		return nil
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = db.LockSharedTreeTx(ctx, tx); err != nil {
		return err
	}
	q := sqlcdb.New(tx)
	keys, err := q.ListStorageGarbage(ctx)
	if err != nil {
		return err
	}
	for _, garbage := range keys {
		key := garbage.ObjectKey
		if garbage.UploadID.Valid {
			core := minio.Core{Client: client}
			err = core.AbortMultipartUpload(ctx, bucket, key, garbage.UploadID.String)
			if err != nil && minio.ToErrorResponse(err).Code != "NoSuchUpload" {
				return err
			}
		}
		if err = client.RemoveObject(ctx, bucket, key, minio.RemoveObjectOptions{}); err != nil {
			return err
		}
		if err = q.DeleteStorageGarbage(ctx, key); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
