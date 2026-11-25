-- name: DeleteExpiredOfficePermits :exec
DELETE FROM office_edit_permits WHERE delivered_at IS NULL AND expires_at <= $1;

-- name: PruneFileVersions :exec
WITH ranked AS (SELECT id,object_key,row_number() OVER(PARTITION BY file_id ORDER BY id DESC) n FROM file_versions), removed AS (DELETE FROM file_versions f USING ranked r WHERE f.id=r.id AND r.n>20 RETURNING f.object_key) INSERT INTO storage_gc(object_key) SELECT object_key FROM removed ON CONFLICT DO NOTHING;

-- name: DateLegacyUploadBatches :exec
UPDATE upload_batches SET created_at=$1 WHERE created_at IS NULL;

-- name: ListExpiredUploadsForAudit :many
SELECT u.id, u.owner_id, usr.username, u.parent_id, u.name, u.size, coalesce(u.batch_id, '')::text AS batch_id, u.relative_path
FROM upload_sessions u
JOIN users usr ON usr.id = u.owner_id
LEFT JOIN upload_batches b ON b.id = u.batch_id
WHERE ((u.state<>'complete' AND u.created_at <= $1::timestamptz-interval '24 hours') OR b.created_at <= $1::timestamptz-interval '24 hours')
  AND EXISTS (
    SELECT 1 FROM upload_transfer_samples s
    WHERE s.session_id = u.id AND s.bytes_transferred > 0
  );

-- name: QueueExpiredUploads :exec
INSERT INTO storage_gc(object_key,upload_id) SELECT u.object_key,u.storage_upload_id FROM upload_sessions u LEFT JOIN upload_batches b ON b.id=u.batch_id WHERE (u.state<>'complete' AND u.created_at <= $1::timestamptz-interval '24 hours') OR b.created_at <= $1::timestamptz-interval '24 hours' ON CONFLICT DO NOTHING;

-- name: DeleteExpiredUploads :exec
DELETE FROM upload_sessions u WHERE (u.state<>'complete' AND u.created_at <= $1::timestamptz-interval '24 hours') OR batch_id IN(SELECT id FROM upload_batches WHERE created_at <= $1::timestamptz-interval '24 hours');

-- name: QueueExpiredBatchVersions :exec
INSERT INTO storage_gc(object_key) SELECT v.object_key FROM file_versions v JOIN upload_batch_nodes n ON n.node_id=v.file_id JOIN upload_batches b ON b.id=n.batch_id WHERE b.created_at <= $1::timestamptz-interval '24 hours' ON CONFLICT DO NOTHING;

-- name: DeleteExpiredBatchVersions :exec
DELETE FROM file_versions WHERE file_id IN(SELECT n.node_id FROM upload_batch_nodes n JOIN upload_batches b ON b.id=n.batch_id WHERE b.created_at <= $1::timestamptz-interval '24 hours');

-- name: ListExpiredBatchNodes :many
SELECT n.node_id FROM upload_batch_nodes n JOIN upload_batches b ON b.id=n.batch_id WHERE b.created_at <= $1::timestamptz-interval '24 hours';

-- name: DeleteExpiredBatchVisibility :exec
DELETE FROM upload_batch_nodes WHERE node_id=ANY($1::bigint[]);

-- name: DeleteExpiredBatches :exec
DELETE FROM upload_batches WHERE created_at <= $1::timestamptz-interval '24 hours';

-- name: DeleteExpiredBatchTreeNodes :exec
DELETE FROM tree_nodes WHERE id=ANY($1::bigint[]);
