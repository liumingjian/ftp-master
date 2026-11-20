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
