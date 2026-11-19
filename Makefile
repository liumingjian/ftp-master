COMPOSE := docker compose -f deploy/local/docker-compose.yml

.PHONY: up down logs generate check-generated build test test-unit test-integration test-e2e run-backend

## up: build and start the whole local stack; the web shell is at http://localhost:8088
up:
	$(COMPOSE) up --build --detach --wait
	@echo "ftp-master is up: http://localhost:8088"

## down: stop the local stack (keeps data volumes; add -v to the compose command to drop them)
down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs --follow app

## generate: regenerate backend and frontend code from api/openapi.yaml and the SQL queries
generate:
	cd backend && go generate ./...
	cd web && pnpm generate

## check-generated: fail if generated code is stale against the contract or the SQL
check-generated:
	cd backend && go test -count=1 ./internal/api/ && go tool sqlc diff
	cd web && pnpm check:api

## build: drift check, then build the service binary and the web shell
build: check-generated
	cd backend && go build -o bin/ftp-master ./cmd/ftp-master
	cd web && pnpm build

test: test-unit test-integration test-e2e

## test-unit: backend unit tests (fast, no Docker) and frontend typecheck
test-unit:
	cd backend && go test ./...
	cd web && pnpm typecheck

## test-integration: HTTP API against real PostgreSQL, MinIO and Redis (needs Docker)
test-integration:
	cd backend && go test -tags integration -count=1 ./...

## test-e2e: Playwright against the running local stack (run `make up` first)
test-e2e:
	cd web && pnpm test:e2e

## run-backend: run the service on the host against the stores of the local stack
run-backend:
	cd backend && go run ./cmd/ftp-master
