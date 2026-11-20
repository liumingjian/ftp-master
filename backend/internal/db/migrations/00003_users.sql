-- Users. Registration, Organizations and lockout arrive with their own tickets.

-- +goose Up
CREATE TABLE users (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username         text NOT NULL CHECK (username <> ''),
    display_name     text NOT NULL,
    password_hash    text NOT NULL,
    is_administrator boolean NOT NULL DEFAULT false,
    status           text NOT NULL CHECK (status IN ('pending', 'active', 'deactivated')),
    created_at       timestamptz NOT NULL
);

-- Usernames are unique regardless of case and looked up the same way.
CREATE UNIQUE INDEX users_username_key ON users (lower(username));

GRANT SELECT, INSERT ON users TO ftp_master_app;

-- +goose Down
DROP TABLE users;
