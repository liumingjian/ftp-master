-- name: CreateRecycleEntry :exec
INSERT INTO recycle_entries(node_id,original_parent_id,original_path,deleted_at) VALUES(@node_id,sqlc.narg(original_parent_id),@original_path,@deleted_at);
-- name: GetRecycleEntry :one
SELECT * FROM recycle_entries WHERE node_id= @node_id;
-- name: ListRecycleEntries :many
SELECT * FROM recycle_entries ORDER BY node_id;
-- name: MarkRecycleSubtree :exec
WITH RECURSIVE subtree AS (SELECT id FROM tree_nodes WHERE id= @root_id UNION ALL SELECT n.id FROM tree_nodes n JOIN subtree s ON n.parent_id=s.id)
UPDATE tree_nodes SET deleted_at= @deleted_at,recycle_root_id= @root_id WHERE id IN (SELECT id FROM subtree);
-- name: RestoreRecycleSubtree :exec
UPDATE tree_nodes SET deleted_at=NULL,recycle_root_id=NULL WHERE recycle_root_id= @root_id;
-- name: DeleteRecycleEntry :exec
DELETE FROM recycle_entries WHERE node_id= @node_id;
-- name: QueueRecycleObjects :exec
INSERT INTO storage_gc(object_key) SELECT object_key FROM file_versions WHERE file_id IN (SELECT n.id FROM tree_nodes n WHERE n.recycle_root_id= @root_id) ON CONFLICT DO NOTHING;
-- name: DeleteRecyclePermits :exec
DELETE FROM office_edit_permits WHERE file_id IN (SELECT n.id FROM tree_nodes n WHERE n.recycle_root_id= @root_id);
-- name: DeleteRecycleUploads :exec
DELETE FROM upload_sessions WHERE parent_id IN (SELECT n.id FROM tree_nodes n WHERE n.recycle_root_id= @root_id) OR file_id IN (SELECT n.id FROM tree_nodes n WHERE n.recycle_root_id= @root_id);
-- name: DeleteRecycleVersions :exec
DELETE FROM file_versions WHERE file_id IN (SELECT n.id FROM tree_nodes n WHERE n.recycle_root_id= @root_id);
-- name: PurgeRecycleNodes :exec
DELETE FROM tree_nodes WHERE recycle_root_id= @root_id;
-- name: ListStorageGarbage :many
SELECT object_key,upload_id FROM storage_gc WHERE NOT EXISTS(SELECT 1 FROM file_versions f WHERE f.object_key=storage_gc.object_key) AND NOT EXISTS(SELECT 1 FROM upload_sessions u WHERE u.object_key=storage_gc.object_key AND u.state<>'complete') AND NOT EXISTS(SELECT 1 FROM office_edit_permits p WHERE p.object_key=storage_gc.object_key AND p.delivered_at IS NULL);
-- name: DeleteStorageGarbage :exec
DELETE FROM storage_gc WHERE object_key= @object_key;

-- name: QueueRecycleUploads :exec
INSERT INTO storage_gc(object_key,upload_id) SELECT object_key,storage_upload_id FROM upload_sessions WHERE parent_id IN (SELECT n.id FROM tree_nodes n WHERE n.recycle_root_id= @root_id) OR file_id IN (SELECT n.id FROM tree_nodes n WHERE n.recycle_root_id= @root_id) ON CONFLICT DO NOTHING;
