# Go backend, React + TypeScript frontend

The implementer is a coding agent (Claude Code), so the stack is chosen for fast, unambiguous feedback loops. Go was chosen over Rust for the backend: the service is mostly authorization, metadata and orchestration (file bytes go straight to MinIO), so Rust's performance buys little, while its slower builds and borrow-checker/async-lifetime churn cost agent iterations. Go gives seconds-long builds, one idiomatic way to do most things, a single static binary for plain-host deployment, and mature clients for MinIO, PostgreSQL and Redis. The frontend is React + TypeScript; types are shared from an OpenAPI contract so frontend/backend drift fails at compile time.

## Considered Options

- **Rust (axum/sqlx)**: stronger compile-time guarantees, rejected for iteration cost relative to benefit in an I/O-orchestration service.
- **Java (Spring Boot)**: rejected; heavier runtime and framework magic that is harder for an agent to reason about.
