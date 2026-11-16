# Office editing through the in-house WPS plugin

Office documents (doc, docx, wps, xls, xlsx) are edited with our own browser extension (`liumingjian/wps-plugin`, the `roadflow-extension` product), which embeds desktop WPS via its NPAPI plugin in Qaxbrowser. We integrate only with that product, not the legacy native-messaging agent. The plugin's constraints shape the host side in ways that would otherwise look wrong:

- **Edit links are path URLs ending in the file extension**, e.g. `/office/files/{fileId}/v/{versionId}/{name}.docx`, served same-origin by the application with no redirect. WPS fetches this URL itself, so presigned MinIO URLs cannot be used here; the application streams the bytes (bounded by the plugin's 25 MiB limit). Ordinary downloads must therefore *not* be plain `<a>` links ending in an extension, or the plugin would hijack them.
- **Authentication is the session cookie only** (HttpOnly). WPS makes its own HTTP requests and cannot attach a bearer token.
- **Saves are full-file multipart uploads** in two different shapes (Writer and ET); the save endpoint accepts both. Each manual save creates one File Version and one Audit Event; opening for edit is also audited.
- **No locking; last save wins.** The plugin cannot surface a lock to the user and has no save-as, so rejecting a save would strand the user's edits. The base version is carried in the edit URL; a save based on a stale version is accepted, creates a new File Version, and is flagged in its Audit Event. Nothing is lost because earlier File Versions remain restorable.
- Edit entry points require the Edit Permission Level and are shown only in Qaxbrowser with the plugin present and for files within the size limit.

## Consequences

The plugin needs changes before integration: per-origin save-path templates instead of the hard-coded `/RoadFlow/uploadfiles/OfficeSave`, a list of trusted origins instead of one, and a page-visible marker so the host can detect it. Its forced revision tracking is kept. Whether WPS sends the session cookie (SameSite behaviour) is unverified and is the first acceptance check of the Office integration milestone.
