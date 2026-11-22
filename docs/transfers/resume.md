# Ticket 13 transfer implementation

- GET /uploads/{id}/parts reads the authoritative storage multipart listing, validates expected part sizes, and paginates. Already published sessions report all parts, making folder retries reuse completed child receipts.
- Browser saves session id, filename, size and geometry; reselect requires name/size match. It skips stored parts, automatically retries when connectivity returns, and registers beforeunload only during transfer. Visiting other folders preserves mounted workers; header links return to destinations.
- Folder manifests reuse per-file upload sessions. A pending-node registry hides the reserved root, directories and completed children from all tree snapshots. The last completed child removes the registry in its publication transaction. The same tree advisory lock serializes publication.
- Scheduler seam for #21: upload_sessions.created_at, state, storage_upload_id/object_key remain the authoritative cleanup inventory. upload_batches plus upload_batch_nodes identify provisional metadata to remove on abandonment. Abort incomplete multipart objects before deleting provisional nodes; keep complete immutable objects referenced by published versions. Batch child rows retain destination parent and relative_path.
- Folder manifest refusal after root reservation can leave an abandoned hidden batch; #21 cleanup should cover that registry too. Empty directories are not represented by the browser's file manifest.

## Verified public seams

- HTTP against real PostgreSQL, Redis and MinIO: policy refusal, multipart publication/retry, authoritative stored-part listing, hidden folder batch publication including nested children. Run `cd backend && go test -tags integration ./internal/app -run 'TestMultipartPublishesOnce|TestFolderBatch|TestUploadPolicy' -count=1`.
- Chromium against a fresh disposable Compose project: real multipart bytes, exact downloaded bytes, both same-name choices, abort/reload/reselect with only the missing part sent, nested directory publication, automatic offline recovery, and beforeunload listener presence only during active transfer. Run `cd web && E2E_BASE_URL=http://localhost:18109 pnpm exec playwright test e2e/uploads.spec.ts` (6 passing tests).
- Unit, TypeScript, Clock and generated-code checks: `make test-unit check-generated`.

The current browser manifest contains files and their relative paths. A pending follow-up must add explicit directory entries and an empty-batch commit operation to preserve empty directories; this is a known acceptance gap, not an exclusion from the transfer contract. Header destination links preserve workers when changing folders within the current mounted file browser; their count is currently displayed per destination row.
