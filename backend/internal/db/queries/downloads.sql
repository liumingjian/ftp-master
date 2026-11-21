-- name: GetFileVersion :one
SELECT * FROM file_versions WHERE file_id=$1 AND ($2::bigint=0 OR id=$2) ORDER BY id DESC LIMIT 1;

-- name: ListFileVersions :many
SELECT v.*, u.username FROM file_versions v JOIN users u ON u.id=v.created_by WHERE file_id=$1 ORDER BY v.id DESC;
