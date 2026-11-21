-- +goose Up
CREATE TABLE office_edit_permits (
 id text PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES users(id),
 file_id bigint NOT NULL REFERENCES tree_nodes(id),
 version_id bigint NOT NULL REFERENCES file_versions(id),
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 delivered_at timestamptz,
 CHECK(expires_at > created_at)
);
GRANT SELECT,INSERT,UPDATE ON office_edit_permits TO ftp_master_app;
-- +goose Down
DROP TABLE office_edit_permits;
