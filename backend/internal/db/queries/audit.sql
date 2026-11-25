-- name: InsertAuditEvent :one
INSERT INTO audit_events (occurred_at, user_id, username, source_ip, action, outcome, item_id, item_path, detail)
VALUES (@occurred_at, @user_id, @username, @source_ip, @action, @outcome, @item_id, @item_path, @detail)
RETURNING id, occurred_at;

-- name: InsertAuditTransferSeries :exec
INSERT INTO audit_transfer_series (event_id, occurred_at, bucket_seconds, points, gaps)
VALUES (@event_id, @occurred_at, @bucket_seconds, @points, @gaps);

-- name: GetAuditTransferSeries :one
SELECT event_id, occurred_at, bucket_seconds, points, gaps
FROM audit_transfer_series
WHERE event_id = sqlc.arg(event_id)::bigint
  AND (sqlc.narg(occurred_at)::timestamptz IS NULL OR occurred_at = sqlc.narg(occurred_at)::timestamptz)
LIMIT 1;

-- name: EnsureAuditPartition :exec
SELECT audit_ensure_partition(@at::timestamptz);

-- name: QueryAuditEvents :many
WITH RECURSIVE orgs AS (
 SELECT id FROM organizations WHERE id = sqlc.arg(organization_id)::bigint
 UNION ALL SELECT o.id FROM organizations o JOIN orgs ON o.parent_id=orgs.id
)
SELECT a.* FROM audit_events a
WHERE occurred_at >= sqlc.arg(from_time)::timestamptz AND occurred_at < sqlc.arg(to_time)::timestamptz
AND (cardinality(sqlc.arg(user_ids)::bigint[])=0 OR user_id=ANY(sqlc.arg(user_ids)::bigint[]))
AND (sqlc.arg(organization_id)::bigint=0 OR user_id IN (SELECT id FROM users WHERE organization_id IN (SELECT id FROM orgs)))
AND (sqlc.arg(action)::text='' OR a.action=sqlc.arg(action))
AND (sqlc.arg(category)::text='' OR (
 (sqlc.arg(category)::text='transfer' AND a.action IN ('upload','download','zip_download')) OR
 (sqlc.arg(category)::text<>'transfer' AND CASE
 WHEN a.action IN ('sign_in','sign_out') THEN 'session'
 WHEN a.action IN ('download','zip_download') THEN 'read'
 WHEN a.action IN ('delete','restore','purge') THEN 'delete'
 WHEN starts_with(a.action,'grant') THEN 'grant'
 WHEN starts_with(a.action,'account') OR starts_with(a.action,'password') OR starts_with(a.action,'registration') THEN 'account'
 ELSE 'write' END=sqlc.arg(category))
))
AND (NOT sqlc.arg(failures_only)::boolean OR outcome='failure')
AND (NOT sqlc.arg(anomalies_only)::boolean OR (a.detail->'transferProfile'->>'anomaly') IN ('stall','failed'))
AND (sqlc.arg(max_avg_bps)::bigint<=0 OR ((a.detail->'transferProfile'->>'avgBps') IS NOT NULL AND (a.detail->'transferProfile'->>'avgBps')::bigint < sqlc.arg(max_avg_bps)::bigint))
AND (sqlc.arg(item_id)::bigint=0 OR item_id=sqlc.arg(item_id) OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(detail->'files','[]'::jsonb)) f WHERE f->>'id'=sqlc.arg(item_id)::text))
AND (sqlc.arg(directory)::text='' OR EXISTS (
 SELECT 1 FROM (SELECT unnest(array_append(ARRAY(SELECT f->>'path' FROM jsonb_array_elements(COALESCE(a.detail->'files','[]'::jsonb)) f), a.item_path)) AS path) paths
 WHERE path=sqlc.arg(directory) OR
 (starts_with(path, CASE WHEN sqlc.arg(directory)='/' THEN '/' ELSE rtrim(sqlc.arg(directory),'/') || '/' END)
 AND (sqlc.arg(recursive)::boolean OR strpos(substring(path FROM length(CASE WHEN sqlc.arg(directory)='/' THEN '/' ELSE rtrim(sqlc.arg(directory),'/') || '/' END)+1),'/')=0))
))
ORDER BY occurred_at DESC,id DESC
LIMIT NULLIF(sqlc.arg(page_limit)::integer,0) OFFSET sqlc.arg(page_offset)::bigint;

-- name: CountAuditEvents :one
WITH RECURSIVE orgs AS (
 SELECT id FROM organizations WHERE id = sqlc.arg(organization_id)::bigint
 UNION ALL SELECT o.id FROM organizations o JOIN orgs ON o.parent_id=orgs.id
)
SELECT count(*) FROM audit_events a
WHERE occurred_at >= sqlc.arg(from_time)::timestamptz AND occurred_at < sqlc.arg(to_time)::timestamptz
AND (cardinality(sqlc.arg(user_ids)::bigint[])=0 OR user_id=ANY(sqlc.arg(user_ids)::bigint[]))
AND (sqlc.arg(organization_id)::bigint=0 OR user_id IN (SELECT id FROM users WHERE organization_id IN (SELECT id FROM orgs)))
AND (sqlc.arg(action)::text='' OR a.action=sqlc.arg(action))
AND (sqlc.arg(category)::text='' OR (
 (sqlc.arg(category)::text='transfer' AND a.action IN ('upload','download','zip_download')) OR
 (sqlc.arg(category)::text<>'transfer' AND CASE
 WHEN a.action IN ('sign_in','sign_out') THEN 'session'
 WHEN a.action IN ('download','zip_download') THEN 'read'
 WHEN a.action IN ('delete','restore','purge') THEN 'delete'
 WHEN starts_with(a.action,'grant') THEN 'grant'
 WHEN starts_with(a.action,'account') OR starts_with(a.action,'password') OR starts_with(a.action,'registration') THEN 'account'
 ELSE 'write' END=sqlc.arg(category))
))
AND (NOT sqlc.arg(failures_only)::boolean OR outcome='failure')
AND (NOT sqlc.arg(anomalies_only)::boolean OR (a.detail->'transferProfile'->>'anomaly') IN ('stall','failed'))
AND (sqlc.arg(max_avg_bps)::bigint<=0 OR ((a.detail->'transferProfile'->>'avgBps') IS NOT NULL AND (a.detail->'transferProfile'->>'avgBps')::bigint < sqlc.arg(max_avg_bps)::bigint))
AND (sqlc.arg(item_id)::bigint=0 OR item_id=sqlc.arg(item_id) OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(detail->'files','[]'::jsonb)) f WHERE f->>'id'=sqlc.arg(item_id)::text))
AND (sqlc.arg(directory)::text='' OR EXISTS (
 SELECT 1 FROM (SELECT unnest(array_append(ARRAY(SELECT f->>'path' FROM jsonb_array_elements(COALESCE(a.detail->'files','[]'::jsonb)) f), a.item_path)) AS path) paths
 WHERE path=sqlc.arg(directory) OR
 (starts_with(path, CASE WHEN sqlc.arg(directory)='/' THEN '/' ELSE rtrim(sqlc.arg(directory),'/') || '/' END)
 AND (sqlc.arg(recursive)::boolean OR strpos(substring(path FROM length(CASE WHEN sqlc.arg(directory)='/' THEN '/' ELSE rtrim(sqlc.arg(directory),'/') || '/' END)+1),'/')=0))
))
;

-- name: AuditHistoricalPaths :many
SELECT DISTINCT path::text FROM (
 SELECT item_path AS path FROM audit_events WHERE item_path IS NOT NULL
 UNION SELECT item_path || '/' FROM audit_events WHERE item_path IS NOT NULL AND (action='create_directory' OR detail->'result'->>'isFile'='false' OR item_id IN (SELECT id FROM tree_nodes WHERE NOT is_file))
 UNION SELECT f->>'path' FROM audit_events CROSS JOIN LATERAL jsonb_array_elements(COALESCE(detail->'files','[]'::jsonb)) f
) paths WHERE path IS NOT NULL ORDER BY path;

-- name: AuditCurrentDirectories :many
WITH RECURSIVE dirs AS (
 SELECT id, ('/' || name)::text AS path FROM tree_nodes WHERE parent_id IS NULL AND NOT is_file AND deleted_at IS NULL
 UNION ALL SELECT n.id,(d.path || '/' || n.name)::text FROM tree_nodes n JOIN dirs d ON n.parent_id=d.id WHERE NOT n.is_file AND n.deleted_at IS NULL
) SELECT path FROM dirs ORDER BY path;
