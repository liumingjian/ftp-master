-- +goose Up
ALTER TABLE users ADD COLUMN session_epoch bigint NOT NULL DEFAULT 0;
GRANT UPDATE(status, session_epoch) ON users TO ftp_master_app;

-- +goose Down
ALTER TABLE users DROP COLUMN session_epoch;
