-- name: ListUsersForQuota :many
SELECT id, organization_id, quota_bytes FROM users ORDER BY id;

-- name: ListCommittedBytesByUser :many
SELECT earliest.created_by AS user_id, COALESCE(SUM(earliest.size), 0)::bigint AS committed_bytes
FROM (
    SELECT DISTINCT ON (object_key) object_key, created_by, size
    FROM file_versions
    ORDER BY object_key, id ASC
) earliest
GROUP BY earliest.created_by
ORDER BY earliest.created_by;

-- name: ListReservedBytesByUser :many
SELECT owner_id AS user_id, COALESCE(SUM(size), 0)::bigint AS reserved_bytes
FROM upload_sessions
WHERE state <> 'complete'
GROUP BY owner_id
ORDER BY owner_id;
