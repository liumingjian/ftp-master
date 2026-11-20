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
	"github.com/pressly/goose/v3/lock"
)

//go:generate go tool sqlc generate -f ../../sqlc.yaml

//go:embed migrations/*.sql
var migrations embed.FS

// Migrate applies every pending migration, in order, to the database behind
// pool. A PostgreSQL advisory lock serialises instances that start at the same
// time, so each migration runs exactly once across the cluster.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()

	dir, err := fs.Sub(migrations, "migrations")
	if err != nil {
		return err
	}
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return fmt.Errorf("prepare migration lock: %w", err)
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, dir, goose.WithSessionLocker(locker))
	if err != nil {
		return fmt.Errorf("prepare migrations: %w", err)
	}
	if _, err := provider.Up(ctx); err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	return nil
}

// LatestVersion is the version of the newest migration this build carries:
// the schema version a fully migrated database reports.
func LatestVersion() (int64, error) {
	names, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		return 0, err
	}
	var latest int64
	for _, name := range names {
		version, err := goose.NumericComponent(name)
		if err != nil {
			return 0, fmt.Errorf("migration %s: %w", name, err)
		}
		latest = max(latest, version)
	}
	return latest, nil
}
