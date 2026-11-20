-- name: ListTreeNodes :many
SELECT * FROM tree_nodes WHERE deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM upload_batch_nodes b WHERE b.node_id=tree_nodes.id) ORDER BY id;
-- name: CreateTreeNode :one
INSERT INTO tree_nodes(parent_id,name,is_file) VALUES (sqlc.narg(parent_id), @name, @is_file) RETURNING *;
-- name: ListGrants :many
SELECT * FROM grants ORDER BY id;
-- name: CreateGrant :one
INSERT INTO grants(node_id,principal_kind,principal_id,rights,scope,creator) VALUES (@node_id,@principal_kind,@principal_id,@rights,@scope,@creator) RETURNING *;
-- name: DeleteGrant :execrows
DELETE FROM grants WHERE id= @id AND node_id= @node_id;
-- name: GetPermissionMembership :one
WITH RECURSIVE ancestors AS (
 SELECT o.id,o.parent_id FROM organizations o JOIN users u ON u.organization_id=o.id WHERE u.id=sqlc.arg(user_id)
 UNION ALL SELECT o.id,o.parent_id FROM organizations o JOIN ancestors a ON a.parent_id=o.id
)
SELECT ARRAY(SELECT id FROM ancestors)::bigint[] AS organization_ids,
 ARRAY(SELECT group_id FROM user_group_members WHERE user_id=sqlc.arg(user_id))::bigint[] AS user_group_ids;

-- name: RenameTreeNode :one
UPDATE tree_nodes SET name= @name WHERE id= @id RETURNING *;
-- name: MoveTreeNode :one
UPDATE tree_nodes SET parent_id=sqlc.narg(parent_id) WHERE id= @id RETURNING *;

-- name: ListLatestTreeVersions :many
SELECT DISTINCT ON (file_id) file_id, id, size, format
FROM file_versions WHERE file_id = ANY(@file_ids::bigint[])
ORDER BY file_id, id DESC;
