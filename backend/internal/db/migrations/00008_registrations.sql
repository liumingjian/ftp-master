-- +goose Up
ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('pending','active','deactivated','rejected'));
ALTER TABLE users ADD COLUMN organization_hint text NOT NULL DEFAULT '';
GRANT UPDATE(status) ON users TO ftp_master_app;
-- +goose Down
UPDATE users SET status='deactivated' WHERE status='rejected';
ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('pending','active','deactivated'));
ALTER TABLE users DROP COLUMN organization_hint;
REVOKE UPDATE(status) ON users FROM ftp_master_app;
