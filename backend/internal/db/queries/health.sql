-- name: SchemaVersion :one
SELECT COALESCE(MAX(version_id), 0)::bigint AS version
FROM goose_db_version
WHERE is_applied;
