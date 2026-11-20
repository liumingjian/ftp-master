-- name: GetFileVersion :one
SELECT * FROM file_versions WHERE file_id=$1 AND ($2::bigint=0 OR id=$2) ORDER BY id DESC LIMIT 1;
