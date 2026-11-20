-- name: CreateRegistration :one
INSERT INTO users(username,display_name,password_hash,status,created_at,organization_hint)
VALUES (@username,@display_name,@password_hash,'pending',@created_at,@organization_hint) RETURNING *;
-- name: ListRegistrations :many
SELECT * FROM users WHERE status='pending' ORDER BY id;
-- name: ActivateRegistration :execrows
UPDATE users SET status='active', organization_id= @organization_id WHERE id= @id AND status='pending';
-- name: RejectRegistration :execrows
UPDATE users SET status='rejected' WHERE id= @id AND status='pending';
