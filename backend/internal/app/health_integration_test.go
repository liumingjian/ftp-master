//go:build integration

package app_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/app"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/liumingjian/ftp-master/backend/internal/db"
)

func TestHealthReadsSchemaVersionFromAFreshDatabase(t *testing.T) {
	stores := startStores(t)
	clk := clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC))
	server := startService(t, stores.config, clk)

	clk.Advance(42 * time.Second)
	status, health := getHealth(t, server)

	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %+v", status, health)
	}
	if health.Status != api.Ok {
		t.Errorf("Status = %q, want ok", health.Status)
	}
	if !health.Database.Up || !health.ObjectStorage.Up || !health.Cache.Up {
		t.Errorf("a store is reported down: %+v", health)
	}
	// Migrations ran forward from empty to the newest one.
	if latest := latestMigration(t); health.Database.SchemaVersion != latest {
		t.Errorf("SchemaVersion = %d, want %d", health.Database.SchemaVersion, latest)
	}
	if want := time.Date(2026, 11, 19, 9, 0, 42, 0, time.UTC); !health.CheckedAt.Equal(want) {
		t.Errorf("CheckedAt = %v, want %v", health.CheckedAt, want)
	}
	if health.UptimeSeconds != 42 {
		t.Errorf("UptimeSeconds = %d, want 42", health.UptimeSeconds)
	}
}

func TestHealthIsDegradedWhenTheCacheIsDown(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))

	if err := stores.redis.Stop(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	status, health := getHealth(t, server)

	if status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body %+v", status, health)
	}
	if health.Status != api.Degraded || health.Cache.Up {
		t.Errorf("want degraded with cache down, got %+v", health)
	}
	if !health.Database.Up || !health.ObjectStorage.Up {
		t.Errorf("database and object storage should still be up: %+v", health)
	}
}

func TestMigrationsAreSafeToRunOnEveryStartup(t *testing.T) {
	stores := startStores(t)
	clk := clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC))
	startService(t, stores.config, clk)

	second := startService(t, stores.config, clk)
	status, health := getHealth(t, second)

	if status != http.StatusOK || health.Database.SchemaVersion != latestMigration(t) {
		t.Fatalf("restarted service: status %d, body %+v", status, health)
	}
}

func latestMigration(t *testing.T) int64 {
	t.Helper()
	latest, err := db.LatestVersion()
	if err != nil {
		t.Fatal(err)
	}
	if latest < 1 {
		t.Fatalf("no migrations found")
	}
	return latest
}

func startService(t *testing.T, cfg app.Config, clk clock.Clock) *httptest.Server {
	t.Helper()
	service, err := app.New(context.Background(), cfg, clk)
	if err != nil {
		t.Fatalf("start service: %v", err)
	}
	t.Cleanup(service.Close)
	server := httptest.NewServer(service.Handler())
	t.Cleanup(server.Close)
	return server
}

func getHealth(t *testing.T, server *httptest.Server) (int, api.Health) {
	t.Helper()
	resp, err := http.Get(server.URL + "/api/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body api.Health
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode health: %v", err)
	}
	return resp.StatusCode, body
}
