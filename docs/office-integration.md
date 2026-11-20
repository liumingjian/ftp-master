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
