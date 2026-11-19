// Package health checks whether the service's backing stores are reachable.
package health

import (
	"context"
	"time"

	"github.com/liumingjian/ftp-master/backend/internal/clock"
)

// Database reports the latest applied migration version read from PostgreSQL.
type Database interface {
	SchemaVersion(ctx context.Context) (int64, error)
}

// Pinger checks that a backing store answers.
type Pinger interface {
	Ping(ctx context.Context) error
}

// Dependency is the reachability of one backing store.
type Dependency struct {
	Up    bool
	Error string
}

// DatabaseDependency is the reachability of PostgreSQL plus the schema version it reported.
type DatabaseDependency struct {
	Dependency
	SchemaVersion int64
}

// Report is the outcome of one health check.
type Report struct {
	Database      DatabaseDependency
	ObjectStorage Dependency
	Cache         Dependency
	CheckedAt     time.Time
	UptimeSeconds int64
}

// OK reports whether every backing store is reachable.
func (r Report) OK() bool {
	return r.Database.Up && r.ObjectStorage.Up && r.Cache.Up
}

// Checker performs health checks. Its start time is the moment it was created.
type Checker struct {
	clock         clock.Clock
	startedAt     time.Time
	database      Database
	objectStorage Pinger
	cache         Pinger
}

// NewChecker returns a Checker that starts counting uptime now, by clk.
func NewChecker(clk clock.Clock, database Database, objectStorage, cache Pinger) *Checker {
	return &Checker{
		clock:         clk,
		startedAt:     clk.Now(),
		database:      database,
		objectStorage: objectStorage,
		cache:         cache,
	}
}

// Check probes every backing store.
func (c *Checker) Check(ctx context.Context) Report {
	report := Report{
		ObjectStorage: probe(ctx, c.objectStorage),
		Cache:         probe(ctx, c.cache),
	}
	version, err := c.database.SchemaVersion(ctx)
	report.Database = DatabaseDependency{Dependency: dependency(err), SchemaVersion: version}

	now := c.clock.Now()
	report.CheckedAt = now
	report.UptimeSeconds = int64(now.Sub(c.startedAt) / time.Second)
	return report
}

func probe(ctx context.Context, p Pinger) Dependency {
	return dependency(p.Ping(ctx))
}

func dependency(err error) Dependency {
	if err != nil {
		return Dependency{Up: false, Error: err.Error()}
	}
	return Dependency{Up: true}
}
