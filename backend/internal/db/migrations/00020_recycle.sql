-- +goose Up
ALTER TABLE tree_nodes ADD COLUMN recycle_root_id bigint;
ALTER TABLE tree_nodes DROP CONSTRAINT tree_nodes_parent_id_name_key;
CREATE UNIQUE INDEX tree_nodes_live_name ON tree_nodes(parent_id,name) NULLS NOT DISTINCT WHERE deleted_at IS NULL;
CREATE TABLE recycle_entries (
 node_id bigint PRIMARY KEY REFERENCES tree_nodes(id),
 original_parent_id bigint,
 original_path text NOT NULL,
 deleted_at timestamptz NOT NULL
);
CREATE TABLE storage_gc (object_key text PRIMARY KEY, upload_id text);
GRANT SELECT,INSERT,UPDATE,DELETE ON recycle_entries,storage_gc TO ftp_master_app;
GRANT DELETE ON upload_sessions,office_edit_permits TO ftp_master_app;
-- +goose Down
DROP TABLE recycle_entries,storage_gc;
DROP INDEX tree_nodes_live_name;
ALTER TABLE tree_nodes ADD UNIQUE NULLS NOT DISTINCT(parent_id,name);
ALTER TABLE tree_nodes DROP COLUMN recycle_root_id;
