-- name: CreateOfficePermit :exec
INSERT INTO office_edit_permits(id,user_id,file_id,version_id,created_at,expires_at,object_key,size,format) SELECT $1,$2,$3,$4,$5,$6,v.object_key,v.size,v.format FROM file_versions v WHERE v.id=$4;

-- name: GetOfficePermit :one
SELECT p.*,n.name FROM office_edit_permits p JOIN tree_nodes n ON n.id=p.file_id WHERE p.id=$1 AND n.deleted_at IS NULL;

-- name: LockOfficePermit :one
SELECT p.*,n.name FROM office_edit_permits p JOIN tree_nodes n ON n.id=p.file_id WHERE p.id=$1 AND n.deleted_at IS NULL FOR UPDATE OF p;

-- name: MarkOfficeDelivered :exec
UPDATE office_edit_permits SET delivered_at=$2 WHERE id=$1;
