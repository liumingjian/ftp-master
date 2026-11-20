-- name: InsertAuditEvent :exec
INSERT INTO audit_events (occurred_at, user_id, username, source_ip, action, outcome, item_id, item_path, detail)
VALUES (@occurred_at, @user_id, @username, @source_ip, @action, @outcome, @item_id, @item_path, @detail);

-- name: EnsureAuditPartition :exec
SELECT audit_ensure_partition(@at::timestamptz);
