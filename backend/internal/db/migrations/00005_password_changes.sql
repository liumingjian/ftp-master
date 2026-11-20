-- +goose Up
GRANT UPDATE (password_hash) ON users TO ftp_master_app;
-- +goose Down
REVOKE UPDATE (password_hash) ON users FROM ftp_master_app;
