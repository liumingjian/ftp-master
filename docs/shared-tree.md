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
Grant test registers and activates another User via HTTP before exercising the
Grant form and visibility in a separate browser context. Run it with:

```sh
cd web
E2E_BASE_URL=http://localhost:8088 pnpm test:e2e tree.spec.ts
```

## Draft Grants

`GET /api/tree/{id}/grant-draft` returns every reaching Grant with `sourceId`,
`sourcePath`, and `inherited`. This includes assignments to other principals,
not just those matching the editor. `POST` takes `add` (TreeGrantInput[]) and
`remove` (direct Grant IDs), at most 100 each. Authorization uses the original
snapshot; all changes and per-change Audit Events commit together. The draft
also records its summary event. Inherited assignments cannot be removed here.
A delegated editor cannot expand a this-level-only Grant into a subtree Grant;
Rights are normalized and bounded by their delegated Rights. File Scope is
normalized to subtree and hidden in the UI. Creator changes are reserved for
the directory-authorized Creator management flow.

`GrantsPanel` is the dedicated permission editor, linked from each manageable
item and the current directory. It keeps additions and removals local until
Save All. Ten individual assignments trigger the suggestion to use membership
principals. `GrantSources` is reusable by impact and permission inspection.
