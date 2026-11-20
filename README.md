# ftp-master

A browser-based file management system. Vocabulary is in `GLOSSARY.md`, decisions in `docs/adr/`.

## Layout

| Path       | What                                                                                   |
| ---------- | -------------------------------------------------------------------------------------- |
| `api/`     | OpenAPI contract, the single source of truth for the HTTP API                          |
| `backend/` | Go service: handlers generated from the contract, sqlc queries over ordered migrations |
| `web/`     | React + TypeScript web app; client types generated from the contract                   |
| `deploy/`  | Deployment; `deploy/local/` is the docker-compose stack for development                |

## Everyday commands

Requires Go (see `backend/go.mod`), Node 24 with pnpm, and Docker.

```sh
make up                # build and start PostgreSQL, MinIO, Redis, the service and the web shell
                       # then open http://localhost:8088 and sign in as admin / admin-local-only
make down              # stop the stack
                       # port taken? e.g. FTP_MASTER_WEB_PORT=18088 FTP_MASTER_REDIS_PORT=16379 make up
                       # (also FTP_MASTER_POSTGRES_PORT, _MINIO_PORT, _MINIO_CONSOLE_PORT, _APP_PORT)

make generate          # after editing api/openapi.yaml or backend/internal/db/queries/*.sql
make check-generated   # fails if generated code is stale (also part of `make build` and CI)

make test-unit         # backend and web unit tests + web typecheck, no Docker needed
make test-integration  # HTTP API against real PostgreSQL, MinIO, Redis via testcontainers
make test-e2e          # Playwright against the running stack (`make up` first)
```

## Conventions

- **Contract first.** Change `api/openapi.yaml`, run `make generate`, then implement the new
  method of `api.StrictServerInterface` in `backend/internal/httpapi`. Never edit `*.gen.go`
  or `schema.gen.ts` by hand. Stale generated code is caught by a regenerate-and-compare
  check, not by the compiler alone: on the backend `go test ./internal/api` and
  `sqlc diff` (run by `make build`, `make run-backend`, the service image build and CI); on
  the frontend `pnpm build` and `pnpm dev`. A bare `go build` does not detect drift.
- **Two database roles.** Migrations run as the schema owner (`MIGRATION_DATABASE_URL`); the
  service connects as `ftp_master_app` (`DATABASE_URL`), which owns nothing and holds only
  what migrations grant it, table by table (there are no default privileges). On Audit Events
  it may only insert and select. The login role must exist before first start:
  `deploy/local/postgres/10-application-role.sql` creates it for the local stack and the
  integration tests. It runs only on an empty data directory, so a stack created before it
  existed needs `docker compose -f deploy/local/docker-compose.yml down -v`.
- **Sign-in.** Every operation requires a signed-in, active User unless the contract marks it
  `security: []`; only sign-in, Registration and health checks may. While no Administrator
  exists, the service creates one from `INITIAL_ADMINISTRATOR_USERNAME` / `INITIAL_ADMINISTRATOR_PASSWORD`.
  Set `TRUSTED_PROXIES` (addresses or CIDRs of the reverse proxies) so Audit Events record
  the client's address from their `X-Forwarded-For`; the session cookie is `Secure` unless `INSECURE_SESSION_COOKIE=true`.
- **Audit Events** are written only through `audit.Recorder.Record`.
- **Migrations** take a PostgreSQL advisory lock, so instances starting together apply each
  one exactly once.
- **Migrations** live in `backend/internal/db/migrations` as `NNNNN_name.sql` (goose format) and
  run forward on every service start and in every integration test. Queries live in
  `backend/internal/db/queries` and are compiled by sqlc into `internal/db/sqlcdb`.
- **Time** is read only through `clock.Clock`; tests advance a `clock.Fake` instead of sleeping.
  `backend/internal/clock/clock_usage_test.go` fails on any direct `time.Now`, `time.Sleep`,
  `context.WithTimeout` etc., and on dot-imports of `time`. A wait on the outside world (such
  as the shutdown grace period) is exempted line by line with `//clock:wallclock <reason>`.
  On the web, `pnpm typecheck` runs `scripts/check-clock.mjs`, which bans `Date.now()`,
  `new Date()`, timers and the like under `src/`.
- **Tests** sit at three seams: the HTTP API (integration, build tag `integration`, real stores via
  testcontainers), the browser (Playwright in `web/e2e`), and pure units (plain `go test`;
  on the web, `src/**/*.test.ts` under Node's test runner).

## Direct browser uploads

Open a directory with Upload, then choose **上传文件**. Progress, speed and ETA
appear in that directory. Administrators configure the extension policy through
**上传扩展名限制**. The local stack signs the browser's localhost MinIO port;
if deploying separately, configure `MINIO_PUBLIC_ENDPOINT`,
`MINIO_PUBLIC_USE_SSL`, `MINIO_REGION`, and storage CORS for the web origin.
See [transfer contracts](docs/shared-tree.md#transfer-integration).
## Bulk User import

Administrators can upload a UTF-8 CSV in Organization management. The browser sends
its decoded contents as `{"csv":"..."}` to `POST /api/users/import`. A UTF-8 BOM,
CRLF and standard CSV quoting are accepted. Limits: 2 MiB, 1000 data records.
The header must be exactly:

```csv
username,display_name,password,organization_id
alice,Alice,initial-password,2
```

`organization_id` is the numeric stable Organization ID shown in the management
list and returned by `GET /api/organizations`; names and hierarchy paths are never
used as identifiers. Usernames and display names are trimmed, nonblank and at most
150 characters; passwords are preserved exactly, nonempty and at most 1024 bytes.
Usernames are unique without regard to case, including pending or deactivated Users.
Every User is created active and non-Administrator and can sign in immediately.

The whole file is validated before creation. HTTP 422 returns an `errors` array of
`{row,message}` entries, using one-based CSV record numbers (header is record 1).
Errors can repeat a row when it has multiple problems. A malformed CSV record stops
parsing where recovery is ambiguous. Any validation or storage failure creates no
Users or import Audit Events. Each successful User creation and its `account_import`
Audit Event commit in the same transaction. Passwords are hashed with the sign-in
policy and never included in Audit Events or validation responses.
