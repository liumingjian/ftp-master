-- +goose Up
CREATE TABLE upload_batches (id text PRIMARY KEY, owner_id bigint NOT NULL REFERENCES users(id), parent_id bigint NOT NULL REFERENCES tree_nodes(id), root_id bigint NOT NULL REFERENCES tree_nodes(id), expected integer NOT NULL CHECK(expected>0));
CREATE TABLE upload_batch_nodes (node_id bigint PRIMARY KEY REFERENCES tree_nodes(id), batch_id text NOT NULL REFERENCES upload_batches(id));
ALTER TABLE upload_sessions ADD COLUMN batch_id text REFERENCES upload_batches(id), ADD COLUMN relative_path text NOT NULL DEFAULT '';
GRANT SELECT,INSERT,UPDATE,DELETE ON upload_batches,upload_batch_nodes TO ftp_master_app;
-- +goose Down
ALTER TABLE upload_sessions DROP COLUMN batch_id, DROP COLUMN relative_path;
DROP TABLE upload_batch_nodes,upload_batches;
