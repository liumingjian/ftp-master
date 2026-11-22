# Office integration contract

[ADR 0005](adr/0005-office-editing-via-wps-plugin.md) defines the supported editing flows and the authorization and delivery model. All URLs below are same-origin relative URLs. Clients use the returned URLs.

## Start an edit

`POST /api/files/{id}/office-edits` requires the active User's session cookie and JSON `{}` (latest version), or `{"versionId": 123}` (an explicit version belonging to this file). Current Modify is required, including for historical versions. The selected version's recorded actual format must be doc, docx, wps, xls or xlsx, and its size must be at most 26,214,400 bytes.

HTTP 201 returns `permitId`, `versionId`, `documentUrl`, `saveUrl`, `deliveryCheckUrl`, `title`, `format` and RFC3339 `expiresAt`. Each start creates a fresh cryptographically random 192-bit identifier. The database holds its User/file/version binding. The permit and `open_for_edit` Audit Event commit in one transaction. The event detail contains `versionId` and `permitId`.

Qaxbrowser can request a read-only permit by adding `"preview": true` to the same POST. Preview requires Browse and uses the same file format, size and five-minute delivery limits. The response omits `saveUrl`. The server rejects saves with a preview permit even when the User has Modify. Preview does not create an Audit Event.

Errors use the ordinary API error envelope: 400 invalid input; 401 missing/invalid session; 403 visible file without Modify; 404 invisible/missing file or version outside the file; 409 directory; 413 too large; 415 unsupported format. No permit or success event is issued on failure.

## Permit routes

- `documentUrl`: `/api/office/permits/{permitId}/document/{escapedFilename}`. No cookie is required. Gateway reads require an undelivered permit strictly before `expiresAt` (five minutes after issuance). It returns the bound version's bytes, without redirects, and records delivery only after a complete response.
- `deliveryCheckUrl`: `/api/office/permits/{permitId}/delivery`. Requires the issuing User's session.
- `saveUrl`: `/api/office/permits/{permitId}/save`. Requires the issuing User's session, completed delivery and current Modify. Gateway expiry limits initial retrieval; a delivered permit remains usable for repeated saves in the editor session. Its bound version is the base for Stale Save evaluation.

These URLs contain the opaque permit identifier, never session cookies, passwords or other account credentials. Treat document URLs as temporary capabilities.

The storage contract for the Gateway/save handlers is `office_edit_permits`: `id`, `user_id`, `file_id`, `version_id`, `created_at`, `expires_at`, nullable `delivered_at`. The generated `GetOfficePermit` query joins immutable content metadata and the current filename. Consumers must check ownership for session-authenticated routes, delivery state, and the injected Clock for initial retrieval.

## Gateway delivery

`GET documentUrl` returns HTTP 200 with `application/octet-stream`, `Cache-Control: no-store` and a streamed response without `Content-Length`. The response terminates only after delivery finalization, so a proxy cannot close
the upstream connection upon reaching a declared length before the delivery
transaction commits. It never redirects, applies
ranges or transforms the selected immutable version. Missing/unknown permits
return 404; expired or delivered permits return 410. Error bodies contain no
document bytes. Filenames are presentation-only; the permit selects the version.
Concurrent requests serialize on the permit row through the transfer and its
commit, so only one complete transfer consumes it. A failed write, canceled
request, failed flush or failed transaction leaves delivery unconfirmed. Network
completion means every byte was accepted and flushed by the HTTP server; it
cannot prove that WPS parsed or displayed those bytes. On macOS, the native
host must also confirm that it staged the Work Copy successfully before opening it.

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

## File-browser presence and edit-link contract

The dedicated ftp-master extension sets `data-ftp-office-plugin` on
`document.documentElement` to its nonempty extension version (for example
`0.1.0`). It must set the marker only on its configured ftp-master origin.
The application observes attribute changes, including late injection and removal.
An absent, empty or whitespace-only value means the plugin is unavailable.
The marker controls presentation only; server authorization remains mandatory.

`GET /api/tree` includes `latestVersion: {id, size, format}` for browsable files
with content. Metadata comes from the latest immutable File Version in one
batched query per listing. It is never inferred from the current filename.
The browser shows an entry only for a file with Modify, a supported actual
format (`doc`, `docx`, `wps`, `xls`, `xlsx`), and size at most 26,214,400 bytes.
The file list currently shows a disabled edit icon for eligible files. In the
file viewer and item details, an otherwise eligible file shows a disabled edit
control explaining that the WPS extension is required when the marker is unavailable.
Missing metadata hides the entry. The explicit version is submitted to start,
so a concurrent upload cannot silently change the document selected by a click.

The entry is an anchor with `data-ftp-office-edit="1"`,
`data-ftp-office-version="<versionId>"`, `target="_blank"`, `rel="noopener"`,
and same-origin `href="/api/files/<fileId>/office-edits"`. The href identifies
the POST edit-start endpoint. The extension handles only trusted unmodified
primary clicks on these explicitly marked anchors on its configured origin.
It prevents navigation and posts `{versionId}`. The application also
suppresses default navigation to the API if the marker is present without an
active handler. The file browser remains open.

## Chrome desktop editing on macOS

The extension uses the browser session for edit start, delivery check and
save. It resolves the returned relative URLs against the configured origin.
The native host receives the resolved Document Gateway URL and the
information it needs to stage the Work Copy. Keep session credentials in
Chrome and handle the Gateway URL as a temporary secret. The host may launch
only a fully staged Work Copy after the extension confirms delivery.

The User saves to disk in WPS and submits from Chrome. The extension submits a
stable copy of the on-disk bytes using the appropriate Writer or ET payload.
The browser reports the created File Version from the HTTP 200 receipt and
refreshes the file browser so the User can reopen that version. The native
host and extension maintain separate state for each Work Copy, including
when multiple edits overlap. See the
[submission ticket](https://github.com/liumingjian/wps-plugin/issues/61) for
recovery, retry and the full 25 MiB transport criteria.

Kylin with Qaxbrowser continues to open the embedded WPS editor in a new tab
and uses the same server contract. Returning closes that editor tab.

Ordinary downloads, including version downloads, use extensionless
`/api/tree/<id>/download` paths and have no edit marker. Neither a filename
suffix nor a document Gateway link grants permission to intercept an anchor.

`web/e2e/office.spec.ts` tests the presence/eligibility matrix at the browser
seam and simulates the extension click handler and WPS client for Writer and
ET against real application endpoints and stores. Its small OOXML fixtures
are structural documents for protocol acceptance, not target-machine WPS
compatibility evidence. See the
[target-machine acceptance ticket](https://github.com/liumingjian/wps-plugin/issues/62).
