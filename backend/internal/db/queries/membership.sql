-- name: ListOrganizations :many
SELECT * FROM organizations ORDER BY id;
-- name: CreateOrganization :one
INSERT INTO organizations(name,parent_id) VALUES (@name,sqlc.narg(parent_id)) RETURNING *;
-- name: UpdateOrganization :one
UPDATE organizations SET name= @name,parent_id=sqlc.narg(parent_id) WHERE id= @id RETURNING *;
-- name: DeleteOrganization :execrows
DELETE FROM organizations WHERE id= @id;
-- name: ListUserGroups :many
SELECT g.id,g.name, COALESCE(array_agg(m.user_id ORDER BY m.user_id) FILTER (WHERE m.user_id IS NOT NULL),'{}'::bigint[])::bigint[] AS user_ids
FROM user_groups g LEFT JOIN user_group_members m ON m.group_id=g.id GROUP BY g.id ORDER BY g.id;
-- name: CreateUserGroup :one
INSERT INTO user_groups(name) VALUES (@name) RETURNING *;
-- name: GetUserGroup :one
SELECT * FROM user_groups WHERE id= @id;
-- name: ClearUserGroupMembers :exec
DELETE FROM user_group_members WHERE group_id= @group_id;
-- name: AddUserGroupMember :exec
INSERT INTO user_group_members(group_id,user_id) VALUES (@group_id,@user_id) ON CONFLICT DO NOTHING;
