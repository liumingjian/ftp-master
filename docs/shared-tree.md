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

`GET /api/tree/zip?ids=ID,ID` expands visible selected directories, includes only
files with current Download, and deduplicates overlapping selections. The latest
immutable versions stream through the application into a ZIP; full tree paths
are preserved with unsafe ZIP name components sanitized. Authorized content
above 10,000,000,000 bytes returns 413 before streaming. `preflight=true` performs
the same metadata check and returns 204 without an Audit Event. The native GET
rechecks independently. The browser only displays the size-limit refusal.
Packing records one `zip_download` event with `detail.files: [{id,path}]` using
historical unsanitized tree paths. A failed storage stream aborts the response;
it never appends a JSON error to a partial archive. ZIP generation uses bounded
buffers and retains only entry metadata in memory.

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

## Recycle Bin

`DELETE /api/tree/{id}` requires Delete on the item and tombstones its entire
subtree in the same transaction as the `delete` Audit Event. Descendants retain
their identities, direct Grants and versions. The deleted root is detached;
its original parent ID and historical path remain in a separate Recycle Entry.
All normal tree consumers load only live nodes, including Administrator reads.
Live sibling-name uniqueness excludes deleted nodes, so restoring can return 409
when another item occupies the original name.

`GET /api/recycle-bin` lists only entries the current User can restore:
Administrator, a Creator Grant holder on the file, or a holder of Delete on its
live original parent. `POST /api/tree/{id}/restore` takes `{}` for that parent;
Administrators may supply `{parentId: ID}` for a live destination directory.
An unavailable original parent requires this explicit choice. `DELETE
/api/tree/{id}/purge` is Administrator-only. Restore and purge share the tree
mutation lock and commit with their Audit Events.

`internal/recycle.Purge(ctx, queries, id)` is the reusable scheduler seam. The
caller must hold advisory transaction lock 725010 and record its Audit Event in
that transaction. Purge queues storage work before removing references and
metadata. `recycle.Collect(ctx,pool,client,bucket)` retries durable `storage_gc`
rows, aborts queued multipart uploads and removes unreferenced immutable objects.
It holds the publication lock while checking both File Version and upload intent
references. A storage failure leaves the queue intact; object removal is
idempotent. `ListRecycleEntries` exposes Clock-stamped deletion times for the
30-day scheduler retention policy.

## Creator sharing and administration

Every file Grant write (legacy create, draft save and draft preview) checks the
intended audience against the original snapshot when the editor lacks Grant on
the parent directory. Each User principal and every current member of an
Organization (including descendants) or User Group must already see the parent.
Visibility includes Traversable Ancestors and explicitly accessible Drop Boxes;
it is not inferred from the proposed file Grant. Inactive members cannot see the
parent and therefore cannot be included by a restricted editor. Membership
changes after a Grant is saved follow normal principal membership semantics.

Only holders of Grant on the parent (or Administrators) can revoke a Creator
Grant through either deletion interface. `TreeGrantInput.creator: true` creates
a file-only User Grant of all Rights and requires that same parent authority.
Transfer is a single draft removing the old Creator Grant and adding its
replacement with `creator: true`; preview, audit and rollback use the ordinary
atomic draft path. The Chinese permission editor exposes Creator markers,
removal and transfer controls and the parent-audience restriction. Existing
self-Grant-loss and broad-subtree warnings retain their original meanings.
## File Versions

`GET /api/tree/{id}/versions` requires Browse and lists all retained versions,
newest first, including their author identity, username and Clock-stamped time.
Historical bytes use the existing extension-free download route with
`?versionId=ID`; each issuance requires current Download and records `download`.
`POST /api/tree/{id}/versions/{versionId}/restore` requires Modify, appends a new
latest File Version attributed to the restoring User, and commits its
`restore_version` Audit Event atomically. Neither earlier version is changed.
Missing or foreign-file versions return 404 after non-disclosing authorization.

Restoration shares the source's immutable `object_key`; it does not copy bytes.
The scheduled cleanup seam (#21) must queue removed keys in `storage_gc` and use
`recycle.Collect` to remove only unreferenced content. Pruning one version must
never remove bytes still referenced by a restored version. Retention remains the
scheduler's responsibility; version history itself does not prune on read.

## Scheduled retention

Each service instance runs `internal/scheduler.Jobs.Run` at startup and hourly;
shutdown cancels and joins the worker before closing its stores. The wakeup
cadence uses a ticker; all age decisions use the injected Clock. The public Run
seam also permits an operator or test to trigger a pass without waiting.
The Shared Tree transaction advisory lock serializes concurrent passes with
publication, restore and purge. Failures roll back metadata; durable storage GC
is retried on the next pass.

Recycle Entries expire at 30 days and each automatic purge records an
`automatic_purge` Audit Event. Each file retains its latest 20 version IDs.
Office permits snapshot their base ID, format and immutable source independently
of retained version metadata. Pending delivery pins the source bytes until expiry;
delivered edits preserve save authority even after the base version is pruned.
Completed upload receipts retain historical version IDs after
pruning, without pinning their original object bytes. Shared immutable references
remain protected by the GC check against retained versions, unfinished uploads
and pending Office deliveries.

Unfinished uploads and hidden folder batches expire 24 hours after creation.
This is an absolute lifetime, including a transfer left open in a browser.
Batch timestamps are Clock-stamped at reservation. Legacy batches without an
intent timestamp conservatively start aging at the first scheduler pass.
Abandoned storage multipart IDs are queued for idempotent abort, and provisional
folder metadata and completed hidden child content are queued for collection.
Metadata cleanup commits before storage operations; a failed storage operation
leaves durable retry work.

The scheduler creates the current and following UTC month partitions and retires
only complete months whose exclusive upper bound is at least 180 days old.
An owner-defined function grants only this bounded partition operation to the
application role; Audit Events remain append-only for that role. Partition creation
and retirement share a separate advisory transaction lock, including on-demand
partition creation by Audit recorders.
## Search, preview and copied links

`GET /api/tree/search?q=literal` matches file names case-insensitively across
all live files with current Browse, including files reached through Traversable
Ancestors. Directories, Drop Box contents without Browse and hidden siblings do
not appear. Queries are literal substrings, not SQL wildcard expressions.

`GET /api/tree/{id}/preview` requires Browse (Download is independent), selects
the latest immutable File Version, and streams passive image, PDF, plain text,
audio and video types. Range requests return ordinary 206/416 responses through
Go's ServeContent and MinIO's seekable immutable object. An explicit format
allowlist rejects HTML, SVG and unknown types with 415. Content-Type is pinned,
content sniffing is disabled, caching is disabled and a restrictive CSP applies. Text and media are sandboxed;
PDF uses the browser's isolated native viewer without sandbox to permit rendering.
Neither search nor preview creates an Audit Event.

The browser copies `/#item=ID` links. After sign-in the application resolves the
stable ID through the authenticated tree endpoint, opens directories or file
previews, and reports unavailable items without revealing their existence.
Renames and moves preserve these links; Grants are evaluated anew on every read.

## Built-in text editing

`GET /api/tree/{id}/text` requires current Modify, reads the latest immutable
version and returns `{versionId, content}` after committing a `text_open` Audit
Event. Supported formats are txt, md, csv, json, xml, log, yaml, yml, toml, ini
and conf. Content must be UTF-8 without NUL bytes and smaller than 10,000,000
bytes. The same limits apply to saves.

`PUT /api/tree/{id}/text` accepts `{baseVersionId, content}`. It rechecks Modify
and the latest version under the publication lock. An outdated base returns 409
without creating content, a File Version or a save Audit Event. The editor keeps
the unsaved buffer and prompts the User to copy changes before reloading and
merging. A successful save returns the ordinary UploadReceipt (201), appends a
fresh immutable object and File Version, and atomically records `text_save` with
both version IDs. Database/audit failure rolls back the version and removes the
unpublished object. Restoration and cleanup reuse the existing version seams.
