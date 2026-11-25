-- name: GetUserByUsername :one
SELECT * FROM users WHERE lower(username) = lower(@username);

-- name: GetUser :one
SELECT * FROM users WHERE id = @id;

-- name: CreateInitialAdministrator :execrows
-- Creates the Administrator only while there is none; safe to run from every
-- instance at once.
INSERT INTO users (username, display_name, password_hash, is_administrator, status, created_at)
SELECT @username, @display_name, @password_hash, true, 'active', @created_at
WHERE NOT EXISTS (SELECT FROM users WHERE is_administrator)
ON CONFLICT DO NOTHING;

-- name: ChangePasswordWithAudit :execrows
WITH changed AS (
 UPDATE users SET password_hash = @new_hash
 WHERE users.id = @target_id AND password_hash = @expected_hash
 RETURNING users.id
)
INSERT INTO audit_events (occurred_at, user_id, username, source_ip, action, outcome, detail)
SELECT @occurred_at, @actor_id, @actor_name, @source_ip, @action, 'success',
 jsonb_build_object('target_user_id', changed.id) FROM changed;

-- name: SetUserStatus :execrows
UPDATE users SET status = @status, session_epoch = session_epoch + CASE WHEN @status = 'deactivated' THEN 1 ELSE 0 END
WHERE id = @id AND status IN ('active', 'deactivated');

-- name: MoveUser :execrows
UPDATE users SET organization_id = @organization_id WHERE id = @id AND status IN ('active', 'deactivated');

-- name: MoveUserWithQuota :execrows
UPDATE users SET organization_id = @organization_id, quota_bytes = @quota_bytes WHERE id = @id AND status IN ('active', 'deactivated');

-- name: SetUserQuota :execrows
UPDATE users SET quota_bytes = @quota_bytes WHERE id = @id AND status IN ('active', 'deactivated');

-- name: ListManagedUsers :many
SELECT * FROM users WHERE status IN ('active','deactivated') ORDER BY username;
