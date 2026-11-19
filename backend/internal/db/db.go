// Package db owns the PostgreSQL schema: ordered migrations and the
// sqlc-generated queries over them (package sqlcdb).
package db

import (
	"context"
	"embed"
	"fmt"
	"io/fs"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
)

//go:generate go tool sqlc generate -f ../../sqlc.yaml

//go:embed migrations/*.sql
var migrations embed.FS

// Migrate applies every pending migration, in order, to the database behind pool.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()

	dir, err := fs.Sub(migrations, "migrations")
	if err != nil {
		return err
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, dir)
	if err != nil {
		return fmt.Errorf("prepare migrations: %w", err)
	}
	if _, err := provider.Up(ctx); err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	return nil
}

// Health reads the schema version through the generated queries.
type Health struct{ queries *sqlcdb.Queries }

// NewHealth returns a health.Database backed by pool.
func NewHealth(pool *pgxpool.Pool) Health { return Health{queries: sqlcdb.New(pool)} }

// SchemaVersion returns the latest applied migration version.
func (h Health) SchemaVersion(ctx context.Context) (int64, error) {
	return h.queries.SchemaVersion(ctx)
}
