-- +goose Up
CREATE TABLE tree_nodes (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 parent_id bigint REFERENCES tree_nodes(id),
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 255 AND name NOT IN ('.','..') AND name !~ '[/\\]'),
 is_file boolean NOT NULL DEFAULT false,
 deleted_at timestamptz,
 UNIQUE NULLS NOT DISTINCT (parent_id,name)
);
CREATE TABLE grants (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 node_id bigint NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
 principal_kind text NOT NULL CHECK (principal_kind IN ('user','organization','user_group')),
 principal_id bigint NOT NULL CHECK (principal_id > 0),
 rights smallint NOT NULL CHECK (rights BETWEEN 1 AND 63),
 scope text NOT NULL DEFAULT 'subtree' CHECK (scope IN ('subtree','this_level_only')),
 creator boolean NOT NULL DEFAULT false
);
CREATE INDEX grants_node_idx ON grants(node_id);
GRANT SELECT,INSERT,UPDATE,DELETE ON tree_nodes,grants TO ftp_master_app;
GRANT USAGE,SELECT ON SEQUENCE tree_nodes_id_seq,grants_id_seq TO ftp_master_app;
-- +goose Down
DROP TABLE grants,tree_nodes;
