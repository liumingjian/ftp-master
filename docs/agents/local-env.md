# Local Development, Routes, DB & QA Reference

Quick lookup for running, inspecting, and testing `ftp-master` locally without hunting through `docker-compose.yml` or source files.

## Local stack & credentials

- **Production-like local stack**: `make up` → `http://localhost:8088` (stop with `make down`).
- **Live Vite hot-reload QA stack**: `make qa-up` → `http://localhost:8088` (mounts `web/src` and `web/index.html` read-only; stop with `make qa-down`).
- **Initial Administrator**: `admin` / `admin-local-only`.
- **Parallel isolated stack** (for worktrees / isolated E2E): pass `-p <project>` with overrides `FTP_MASTER_WEB_PORT`, `FTP_MASTER_APP_PORT`, `FTP_MASTER_POSTGRES_PORT`, `FTP_MASTER_REDIS_PORT`, `FTP_MASTER_MINIO_PORT`, `FTP_MASTER_MINIO_CONSOLE_PORT`, and optional `FTP_MASTER_SUBNET` / `FTP_MASTER_WEB_IP`.

## PostgreSQL access

Local Compose container: `ftp-master-postgres-1`, database `ftpmaster`.

- **Schema owner** (migrations / ad-hoc inspection): `docker exec ftp-master-postgres-1 psql -U ftpmaster -d ftpmaster -c "..."`
- **Application runtime role** (least-privilege, table-by-table grants only): `ftp_master_app` (`DATABASE_URL`).

## Frontend routes & module map

Signed-in pages use **query routing** (`/?view=...`), not `#hash` routes (except `/#item=<id>` deep links inside the file browser).

| URL | Component | Dedicated CSS |
| --- | --- | --- |
| `/` and `/#item=<id>` | `web/src/TreePanel.tsx` (+ `ItemInspectorDialog.tsx`, `FileViewer.tsx`, `TextEditor.tsx`) | `app.css`, `fileDetails.css`, `viewer.css` |
| `/?view=grants&grant=<id>` | `web/src/GrantsPanel.tsx` | `grants.css` |
| `/?view=membership` | `web/src/MembershipPanel.tsx` | `membership.css` |
| `/?view=registrations` | `web/src/RegistrationsPanel.tsx` | `app.css` |
| `/?view=audit` | `web/src/AuditPanel.tsx` (+ `AuditFilters.tsx`, `TransferProfileChart.tsx`, `TransferTrendDialog.tsx`) | `audit.css` |
| `/?view=settings` | `web/src/UploadSettings.tsx` | `admin.css` |
| `/?view=status` | `web/src/HealthPanel.tsx` | `admin.css` |
| `/?view=account` | `web/src/PasswordPanel.tsx` (+ `AccountStorageSection.tsx`) | `admin.css`, `storage.css` |
| `/sign-in`, `/register` | `web/src/SignInPage.tsx`, `web/src/RegistrationPage.tsx` | `app.css` |

Design tokens live in `web/src/tokens.css` (imported first in `web/src/main.tsx`).

## Backend module map

- **HTTP contract (source of truth)**: `api/openapi.yaml` (check handlers here rather than reading the 8k-line `backend/internal/api/api.gen.go`).
- **HTTP handlers**: `backend/internal/httpapi/` (`tree.go`, `grant_draft.go`, `grant_inspection.go`, `creator.go`, `uploads.go`, `upload_batches.go`, `downloads.go`, `zip.go`, `preview_search.go`, `text.go`, `versions.go`, `recycle.go`, `membership.go`, `import_users.go`, `user_lifecycle.go`, `registrations.go`, `quota.go`, `me_storage.go`, `audit_query.go`, `office_*.go`, `auth.go`, `session.go`, `passwords.go`).
- **Domain packages**: `backend/internal/permission/`, `backend/internal/tree/`, `backend/internal/quota/`, `backend/internal/audit/`, `backend/internal/recycle/`, `backend/internal/scheduler/`, `backend/internal/clock/`.
- **Database**: migrations in `backend/internal/db/migrations/` (starts at `00001_baseline.sql`), SQL queries in `backend/internal/db/queries/`, advisory lock helpers in `backend/internal/db/locks.go`.

## Playwright E2E & ad-hoc browser scripts

- **Run specific spec**: `cd web && E2E_BASE_URL=http://localhost:8088 pnpm test:e2e permissions.spec.ts`
- **Ad-hoc Playwright scripts** (outside `web/`): resolve from `web/node_modules`:
  ```js
  import { createRequire } from 'node:module'
  const { chromium } = createRequire(import.meta.url)('/Users/lmj/repos/ftp-master/web/node_modules/@playwright/test')
  ```
