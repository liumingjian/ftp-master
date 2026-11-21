-- +goose Up
CREATE TABLE upload_policy (id boolean PRIMARY KEY DEFAULT true CHECK(id), blocked_extensions text[] NOT NULL);
INSERT INTO upload_policy VALUES(true, ARRAY['exe','com','bat','cmd','sh','ps1','js','vbs','msi','scr']);
CREATE TABLE file_versions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 file_id bigint NOT NULL REFERENCES tree_nodes(id),
 object_key text NOT NULL UNIQUE,
 size bigint NOT NULL CHECK(size>=0),
 format text NOT NULL DEFAULT '',
 created_by bigint NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL
);
CREATE TABLE upload_sessions (
 id text PRIMARY KEY,
 owner_id bigint NOT NULL REFERENCES users(id),
 parent_id bigint NOT NULL REFERENCES tree_nodes(id),
 name text NOT NULL,
 size bigint NOT NULL CHECK(size BETWEEN 0 AND 20000000000),
 object_key text NOT NULL UNIQUE,
 storage_upload_id text NOT NULL,
 part_size bigint NOT NULL,
 part_count integer NOT NULL,
 state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','completing','complete')),
 file_id bigint REFERENCES tree_nodes(id),
 version_id bigint REFERENCES file_versions(id),
 created_at timestamptz NOT NULL
);
GRANT SELECT,INSERT,UPDATE ON upload_policy,upload_sessions TO ftp_master_app;
GRANT SELECT,INSERT,DELETE ON file_versions TO ftp_master_app;
GRANT USAGE,SELECT ON SEQUENCE file_versions_id_seq TO ftp_master_app;
-- +goose Down
DROP TABLE upload_sessions,file_versions,upload_policy;
