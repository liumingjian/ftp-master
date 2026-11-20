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

## Transfer integration

`POST /api/uploads` takes `{parentId,name,size}` (decimal bytes, maximum
20,000,000,000) and returns opaque `id`, fixed `partSize` and `partCount`.
`POST /api/uploads/{id}/parts` takes `{numbers:[1,...]}` (at most 100),
authorizes current Upload and session ownership, and returns 15-minute PUT
capabilities. Send raw sliced bytes without cookies or application authorization.
`POST /api/uploads/{id}/complete` checks every authoritative S3 part and returns
`{fileId,versionId}`; repeated/concurrent successful calls return that receipt.
Zero bytes use one empty final part. Browser progress is displayed within the
chosen destination and uses the injectable monotonic web Clock for speed/ETA.

`GET /api/upload-policy` returns blockedExtensions. Administrator-only PUT
replaces the case-insensitive extension list and audits the change. Upload
validation happens before storage capabilities are issued. Default policy blocks
common executable and script extensions; an empty list explicitly allows all.

Operational MinIO uses MINIO_ENDPOINT. MINIO_PUBLIC_ENDPOINT and
MINIO_PUBLIC_USE_SSL configure a separately signed browser-reachable endpoint;
MINIO_REGION defaults to us-east-1. Do not rewrite signed hosts, queries or paths.
Local Compose sets MinIO's global CORS origin to the web address. Production must
configure the corresponding origin; bucket contents remain private. Permission
revocation prevents new capabilities; already issued capabilities expire normally.

Persistence seams for subsequent tickets: upload_sessions records owner,
destination, name, exact expected size, immutable random object_key, storage
upload id, fixed part layout, state, receipt and Clock creation time. Resume can
list authoritative S3 parts through minio.Core and request bounded replacement
URLs. file_versions records file_id, object_key, size, actual format, created_by
and created_at; latest is the largest version id for a file. Download and Office
read the selected immutable reference rather than deriving a key from a path.

Completion persists `completing` before S3 completion, then locks the session and
Shared Tree mutation advisory lock 725010. An exact-key StatObject with matching
intent metadata and size recovers S3 success if the metadata transaction failed.
File, initial version, Creator Grant, upload Audit Event and receipt publish in
one PostgreSQL transaction. Visible name collisions use the resolution flow
below; existing storage objects are never overwritten.
An S3 object completed before a failed publication remains discoverable through
the session for retry or later abandoned-upload cleanup. S3 and PostgreSQL do not
share a transaction. Upload bodies never pass through the application.

For isolated local acceptance, Compose also accepts FTP_MASTER_SUBNET and
FTP_MASTER_WEB_IP alongside the existing port overrides.
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

`POST /api/tree/{id}/rename` accepts `{name}` and requires Modify on the
item. `POST /api/tree/{id}/move` accepts `{parentId}` and requires Delete on
its source parent plus Upload on the destination. Moving a top-level item or
moving to root (`parentId: null`) requires Administrator. A file cannot be a
parent; cycles and destination name collisions return 409. Names cannot be
blank, dot segments, longer than 255 characters, or contain slash, backslash
or NUL. Both operations retain stable IDs and direct Grants, change only
metadata, and commit with an Audit Event containing `oldPath` and `newPath`.
Inherited Rights are evaluated again against the destination. The browser's
move picker navigates visible directories and enables destinations with Upload.

## Single-file downloads

`GET /api/tree/{id}/download` authorizes current Download and redirects (302)
to a separately signed public MinIO GET capability, valid for 15 minutes.
Optional `versionId` selects that file's immutable version; omit for latest.
Invisible files return 404, visible files without Download return 403, and
folders return 409. Invalid or unrelated versions never disclose bytes.
The redirect has `Cache-Control: no-store`; the signed storage response forces
an attachment with the current Unicode filename and octet-stream content type.
Each issued redirect records one `download` Audit Event with stable item ID,
current path, version ID and size. Issuance is audited, not completed receipt
of bytes; existing capabilities survive permission revocation until expiry.

The UI links only to the extensionless application endpoint and uses native
browser downloads. No transfer body or progress travels through the app.
Subsequent read flows can reuse `fileAccess` for current Right checks and
`GetFileVersion` for file-bound immutable references (version 0 selects latest).

### Same-name uploads

Completion returns `409` with `message: upload_name_conflict` for a visible
clash. Retry with `?collision=new_version` or `?collision=keep_both`. The choice
is durable before storage completion; a retry without the query reuses it.
New-version requires Upload on the destination, appends an immutable version to
the existing file identity, and preserves its Creator Grants. Keep-both creates
a new identity and Creator Grant, using `name (1).ext` and subsequent free names.
A hidden clash always creates a new file with a random suffix, even if the caller
requests new-version; the response never identifies the hidden item. A directory
clash supports keep-both only. Publication, version, audit and receipt commit
atomically under the tree mutation lock, and completed retries return one receipt.
