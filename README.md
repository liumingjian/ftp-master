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
                       # then open http://localhost:8088
make down              # stop the stack

make generate          # after editing api/openapi.yaml or backend/internal/db/queries/*.sql
make check-generated   # fails if generated code is stale (also part of `make build` and CI)

make test-unit         # backend unit tests + web typecheck, no Docker needed
make test-integration  # HTTP API against real PostgreSQL, MinIO, Redis via testcontainers
make test-e2e          # Playwright against the running stack (`make up` first)
```

## Conventions

- **Contract first.** Change `api/openapi.yaml`, run `make generate`, then implement the new
  method of `api.StrictServerInterface` in `backend/internal/httpapi`. Never edit `*.gen.go`
  or `schema.gen.ts` by hand. Stale generated code is caught by a regenerate-and-compare
  check, not by the compiler alone: on the backend `go test ./internal/api` (run by
  `make build`, the service image build and CI); on the frontend `pnpm build`. A bare
  `go build` does not detect drift.
- **Migrations** take a PostgreSQL advisory lock, so instances starting together apply each
  one exactly once.
- **Migrations** live in `backend/internal/db/migrations` as `NNNNN_name.sql` (goose format) and
  run forward on every service start and in every integration test. Queries live in
  `backend/internal/db/queries` and are compiled by sqlc into `internal/db/sqlcdb`.
- **Time** is read only through `clock.Clock`; tests advance a `clock.Fake` instead of sleeping.
  `backend/internal/clock/clock_usage_test.go` fails on any direct `time.Now`, `time.Sleep` etc.
- **Tests** sit at three seams: the HTTP API (integration, build tag `integration`, real stores via
  testcontainers), the browser (Playwright in `web/e2e`), and pure units (plain `go test`).
