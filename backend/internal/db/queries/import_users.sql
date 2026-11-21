-- name: LockUserImport :exec
SELECT lock_user_import();

-- name: CreateImportedUser :one
INSERT INTO users (username, display_name, password_hash, organization_id, status, is_administrator, created_at)
VALUES (@username, @display_name, @password_hash, @organization_id, 'active', false, @created_at)
RETURNING id;
