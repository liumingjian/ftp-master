# Shared Tree integration

`GET /api/tree?parentId=ID` lists visible children; omit `parentId` for the
Shared Tree root. `GET /api/tree/{id}` returns one visible node. IDs are stable
bigints; parent pointers and names describe location, never identity.

`POST /api/tree` creates a directory (`name`, optional `parentId`). Creating a
Top-level Directory requires Administrator; nested creation requires Upload.
`/api/tree/{id}/grants` lists or creates direct Grants; DELETE its `/{grantId}`
revokes one. These operations require Grant. Principals use `user`,
`organization`, `user_group`; Scope uses `subtree` or `this_level_only`.
Rights are the permission module's bit set: Browse 1, Download 2, Upload 4,
Modify 8, Delete 16, Grant 32. Dependencies are normalized by `Coherent`.

The SQL queries and `internal/tree.Load(ctx, queries, permission.User)` are the
reusable persistence and authorization interfaces. Load inside the mutation's
transaction; use the same query handle for writes and audit recording.
`Snapshot.Permission(id)` delegates all resolution to the pure Effective
Permission module. `Visible` includes directories with Upload and Traversable
Ancestors. `NavigationVisible` filters paths inside a directory without Browse:
inherited Upload must never reveal a Drop Box's contents. `Path` is a current
path for recording Audit Events; Audit Event identity remains the node ID.

The browser shows only enabled operations permitted by its server-supplied Rights.
The server independently returns 404 for invisible items and 403 for visible
items lacking the requested Right. A Traversable Ancestor conveys no Right.
Browsing records no Audit Event. Grant changes and directory creation commit
with their Audit Event under the Shared Tree mutation advisory lock (725010).

The real-store HTTP tests cover create/list, deep traversal, hidden siblings,
Drop Box listing suppression and creation, Right unions, Organization ancestors,
User Group membership, refusal statuses, and Grant Audit Events. The browser
Grant test currently fixtures an ordinary User through PostgreSQL because the
Registration API is delivered separately; set `E2E_POSTGRES_CONTAINER` when the
Compose project name differs from `ftp-ticket10`. Run it with:

```sh
cd web
E2E_BASE_URL=http://localhost:8088 E2E_POSTGRES_CONTAINER=ftp-master-postgres-1 pnpm test:e2e tree.spec.ts
```
