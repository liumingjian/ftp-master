-- name: CreateOfficePermit :exec
INSERT INTO office_edit_permits(id,user_id,file_id,version_id,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6);

-- name: GetOfficePermit :one
SELECT p.*,v.object_key,v.size,v.format,n.name FROM office_edit_permits p JOIN file_versions v ON v.id=p.version_id JOIN tree_nodes n ON n.id=p.file_id WHERE p.id=$1;

-- name: LockOfficePermit :one
SELECT p.*,v.object_key,v.size,v.format,n.name FROM office_edit_permits p JOIN file_versions v ON v.id=p.version_id JOIN tree_nodes n ON n.id=p.file_id WHERE p.id=$1 FOR UPDATE OF p;

-- name: MarkOfficeDelivered :exec
UPDATE office_edit_permits SET delivered_at=$2 WHERE id=$1;
