# Office integration contract

ADR 0005 defines the authorization and delivery model. All URLs below are same-origin relative URLs. Clients use the returned URLs; they do not construct routes.

## Start an edit

`POST /api/files/{id}/office-edits` requires the active User's session cookie and JSON `{}` (latest version), or `{"versionId": 123}` (an explicit version belonging to this file). Current Modify is required, including for historical versions. The selected version's recorded actual format must be doc, docx, wps, xls or xlsx, and its size must be at most 26,214,400 bytes.

HTTP 201 returns `permitId`, `versionId`, `documentUrl`, `saveUrl`, `deliveryCheckUrl`, `title`, `format` and RFC3339 `expiresAt`. Each start creates a fresh cryptographically random 192-bit identifier. The database holds its User/file/version binding. The permit and `open_for_edit` Audit Event commit in one transaction. The event detail contains `versionId` and `permitId`.

Errors use the ordinary API error envelope: 400 invalid input; 401 missing/invalid session; 403 visible file without Modify; 404 invisible/missing file or version outside the file; 409 directory; 413 too large; 415 unsupported format. No permit or success event is issued on failure.

## Permit routes

- `documentUrl`: `/api/office/permits/{permitId}/document/{escapedFilename}`. No cookie is required. Gateway reads require an undelivered permit strictly before `expiresAt` (five minutes after issuance). It returns the bound version's bytes, without redirects, and records delivery only after a complete response.
- `deliveryCheckUrl`: `/api/office/permits/{permitId}/delivery`. Requires the issuing User's session.
- `saveUrl`: `/api/office/permits/{permitId}/save`. Requires the issuing User's session, completed delivery and current Modify. Gateway expiry limits initial retrieval; a delivered permit remains usable for repeated saves in the editor session. Its bound version is the base for Stale Save evaluation.

These URLs contain the opaque permit identifier, never session cookies, passwords or other account credentials. Treat document URLs as temporary capabilities.

The storage contract for the Gateway/save handlers is `office_edit_permits`: `id`, `user_id`, `file_id`, `version_id`, `created_at`, `expires_at`, nullable `delivered_at`. The generated `GetOfficePermit` query joins immutable content metadata and the current filename. Consumers must check ownership for session-authenticated routes, delivery state, and the injected Clock for initial retrieval.

## Gateway delivery

`GET documentUrl` returns HTTP 200 with `application/octet-stream`, an exact
`Content-Length`, and `Cache-Control: no-store`. It never redirects, applies
ranges or transforms the selected immutable version. Missing/unknown permits
return 404; expired or delivered permits return 410. Error bodies contain no
document bytes. Filenames are presentation-only; the permit selects the version.
Concurrent requests serialize on the permit row through the transfer and its
commit, so only one complete transfer consumes it. A failed write, canceled
request, failed flush or failed transaction leaves delivery unconfirmed. Network
completion means every byte was accepted and flushed by the HTTP server; it
cannot prove that WPS parsed or displayed those bytes.

`GET deliveryCheckUrl` returns `{ "delivered": false }` or
`{ "delivered": true }`. It waits for an in-flight transfer to finish before
reporting. Missing sessions receive 401, and unknown permits or permits issued
to another User receive 404. Expiry prevents initial retrieval, but does not
hide the delivery state or undo a previously completed delivery. No Audit Event
is added for retrieval or delivery checks; edit start already records the open.

## Save receipt and payloads

`POST saveUrl` uses `multipart/form-data`. Writer sends exactly one `filedata`
part, one nonempty `filename` value and one 32-character hexadecimal `md5sum`
value matching the file bytes. ET sends exactly one `file` part with
`filename=""`, or one `file` form value; both preserve the raw field bytes.
Duplicate or extra fields, nonempty ET filenames and malformed multipart bodies
are refused. The save body is limited to 26 MiB including multipart overhead;
each content field is limited to 25 MiB.

The server parses OOXML ZIP/XML or legacy CFB Word/BIFF streams, verifies the
actual document family against both request shape and permit base version,
and records the actual `doc`, `docx`, `xls` or `xlsx` serialization. A `.wps`
file may save a compatible Word serialization. Neither client filename nor
MIME type determines the stored format. The current shared-tree name stays intact.

HTTP 200 returns `{ "Success": true, "Message": "Saved", "Data": { ... } }`.
`Data` includes `versionId`, `baseVersionId`, `permitId`, `format` and
`staleSave`. Every failure, including authentication, decoding and storage
failure, uses a non-2xx response with `{ "Success": false, "Message": "...",
"Data": null }`. A fresh immutable content object is published with exactly
one File Version and one `office_save` Audit Event in the same database
transaction. Failed publication rolls back both and removes the unused object.
The tree mutation lock serializes publication and current Modify checks;
staleness always compares the latest version to the permit's original base,
including on repeated saves. A delivered permit's initial retrieval expiry does
not prevent later saves by its owner.
