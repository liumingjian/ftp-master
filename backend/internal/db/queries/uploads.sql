-- name: GetUploadPolicy :one
SELECT blocked_extensions FROM upload_policy WHERE id;
-- name: SetUploadPolicy :exec
UPDATE upload_policy SET blocked_extensions=$1 WHERE id;
-- name: CreateUploadSession :exec
INSERT INTO upload_sessions(id,owner_id,parent_id,name,size,object_key,storage_upload_id,part_size,part_count,created_at)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);
-- name: GetUploadSessionForUpdate :one
SELECT * FROM upload_sessions WHERE id=$1 FOR UPDATE;
-- name: MarkUploadCompleting :exec
UPDATE upload_sessions SET state='completing' WHERE id=$1;
-- name: PublishUploadReceipt :exec
UPDATE upload_sessions SET state='complete',file_id=$2,version_id=$3 WHERE id=$1;
-- name: CreateFileVersion :one
INSERT INTO file_versions(file_id,object_key,size,format,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *;

-- name: CreateUploadBatch :exec
INSERT INTO upload_batches(id,owner_id,parent_id,root_id,expected,created_at) VALUES($1,$2,$3,$4,$5,$6);
-- name: HideUploadBatchNode :exec
INSERT INTO upload_batch_nodes(node_id,batch_id) VALUES($1,$2);
-- name: AttachUploadBatch :exec
UPDATE upload_sessions SET batch_id=$2,relative_path=$3 WHERE id=$1;
-- name: SetUploadCollision :exec
UPDATE upload_sessions SET collision=$2 WHERE id=$1;
-- name: GetUploadPublication :one
SELECT collision,coalesce(batch_id,'')::text AS batch_id,relative_path FROM upload_sessions WHERE id=$1;
-- name: GetUploadBatchRoot :one
SELECT n.id,n.name FROM upload_batches b JOIN tree_nodes n ON n.id=b.root_id WHERE b.id=$1;
-- name: FindUploadDirectory :one
SELECT id FROM tree_nodes WHERE parent_id=$1 AND name=$2 AND NOT is_file AND deleted_at IS NULL;
-- name: UploadBatchReady :one
SELECT (count(*)=b.expected AND bool_and(s.state='complete'))::boolean AS ready FROM upload_batches b JOIN upload_sessions s ON s.batch_id=b.id WHERE b.id=sqlc.arg(batch_id) GROUP BY b.expected;
-- name: GrantUploadBatchCreator :exec
INSERT INTO grants(node_id,principal_kind,principal_id,rights,scope,creator) SELECT root_id,'user',owner_id,63,'subtree',true FROM upload_batches b WHERE b.id=$1;
-- name: RevealUploadBatch :exec
DELETE FROM upload_batch_nodes WHERE batch_id=$1;

-- name: InsertUploadTransferSample :exec
INSERT INTO upload_transfer_samples(session_id, part_number, started_at, ended_at, bytes_transferred, samples)
VALUES($1, $2, $3, $4, $5, $6);

-- name: ListUploadTransferSamples :many
SELECT id, session_id, part_number, started_at, ended_at, bytes_transferred, samples
FROM upload_transfer_samples
WHERE session_id=$1
ORDER BY started_at ASC, id ASC;

-- name: QueueCancelledUpload :exec
INSERT INTO storage_gc(object_key, upload_id) VALUES($1, $2) ON CONFLICT DO NOTHING;

-- name: DeleteUploadSession :exec
DELETE FROM upload_sessions WHERE id=$1;

-- name: GetUploadBatchForUpdate :one
SELECT * FROM upload_batches WHERE id=$1 FOR UPDATE;

-- name: ListUploadBatchNodeIDs :many
SELECT node_id FROM upload_batch_nodes WHERE batch_id=$1;

-- name: QueueUploadBatchSessions :exec
INSERT INTO storage_gc(object_key, upload_id)
SELECT object_key, storage_upload_id
FROM upload_sessions
WHERE batch_id=$1
ON CONFLICT DO NOTHING;

-- name: QueueUploadBatchVersions :exec
INSERT INTO storage_gc(object_key)
SELECT v.object_key
FROM file_versions v
JOIN upload_batch_nodes n ON n.node_id=v.file_id
WHERE n.batch_id=$1
ON CONFLICT DO NOTHING;

-- name: DeleteUploadBatchSessions :exec
DELETE FROM upload_sessions WHERE batch_id=$1;

-- name: DeleteUploadBatchVersions :exec
DELETE FROM file_versions
WHERE file_id IN (SELECT node_id FROM upload_batch_nodes WHERE batch_id=$1);

-- name: DeleteUploadBatchNodes :exec
DELETE FROM upload_batch_nodes WHERE batch_id=$1;

-- name: DeleteUploadBatch :exec
DELETE FROM upload_batches WHERE id=$1;

-- name: DeleteTreeNodesByIDs :exec
DELETE FROM tree_nodes WHERE id=ANY($1::bigint[]);
