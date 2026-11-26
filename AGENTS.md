# ftp-master Agent Guide

## 项目 UI 约束

本项目的 UI 面向桌面浏览器。设计、原型、实现和验收均以桌面窗口及鼠标、键盘操作为准。手机端适配与手机视口验收不在项目范围内。

## Context pointers

- **Domain terms & architecture decisions**: read `GLOSSARY.md` and relevant `docs/adr/` before designing, naming, or writing tests (see `docs/agents/domain.md`).
- **Issues & triage**: tracked in GitHub Issues for `liumingjian/ftp-master` via `gh` (`docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`).
- **HTTP & SQL contracts**: edit `api/openapi.yaml` or `backend/internal/db/queries/*.sql`, then run `make generate`; verify with `make check-generated` (never hand-edit `*.gen.go`, `sqlcdb/`, or `schema.gen.ts`).
- **Shared Tree, transfers & quotas**: see `docs/shared-tree.md` and `docs/adr/0008-proxy-transfers-for-throughput-audit.md` / `docs/adr/0010-hierarchical-storage-quotas.md`.
- **Office Plugin**: server contract is `docs/office-integration.md` (ADR 0005); browser extension code lives in sibling repo `~/repos/wps-plugin` on branch `ftp-master`.
- **Local stack, routes, DB & Playwright QA**: see `docs/agents/local-env.md` (and `Makefile` for build/test targets).

## Invariants enforced by checks

- **Time**: read time only through `clock.Clock` (Go) and `web/src/clock.ts` (web). Direct wall-clock calls fail `go test ./...` and `pnpm typecheck`.
- **CSS typography**: use tokens from `web/src/tokens.css` (`--font-*`, `--text-*`, `--weight-*`, `--leading-*`). Hardcoded literals fail `pnpm typecheck`.
- **PostgreSQL advisory locks**: acquire locks only via `backend/internal/db` helpers (`LockMembershipTx`, `LockSharedTreeTx`, `LockMembershipAndSharedTreeTx`) to preserve the `725005` -> `725010` lock order.
