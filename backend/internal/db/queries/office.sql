-- name: CreateOfficePermit :exec
INSERT INTO office_edit_permits(id,user_id,file_id,version_id,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6);

-- name: GetOfficeVersion :one
SELECT * FROM file_versions WHERE file_id=$1 AND ($2::bigint=0 OR id=$2) ORDER BY id DESC LIMIT 1;

-- name: GetOfficePermit :one
SELECT p.*,v.object_key,v.size,v.format,n.name FROM office_edit_permits p JOIN file_versions v ON v.id=p.version_id JOIN tree_nodes n ON n.id=p.file_id WHERE p.id=$1;
