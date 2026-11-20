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
