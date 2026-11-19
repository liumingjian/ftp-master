package health_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/liumingjian/ftp-master/backend/internal/health"
)

type stubDatabase struct {
	version int64
	err     error
}

func (s stubDatabase) SchemaVersion(context.Context) (int64, error) { return s.version, s.err }

type stubPinger struct{ err error }

func (s stubPinger) Ping(context.Context) error { return s.err }

var start = time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)

func TestReportUsesTheClockForCheckedAtAndUptime(t *testing.T) {
	clk := clock.NewFake(start)
	checker := health.NewChecker(clk, stubDatabase{version: 1}, stubPinger{}, stubPinger{})

	clk.Advance(90 * time.Second)
	report := checker.Check(context.Background())

	if want := time.Date(2026, 11, 19, 9, 1, 30, 0, time.UTC); !report.CheckedAt.Equal(want) {
		t.Errorf("CheckedAt = %v, want %v", report.CheckedAt, want)
	}
	if report.UptimeSeconds != 90 {
		t.Errorf("UptimeSeconds = %d, want 90", report.UptimeSeconds)
	}

	clk.Advance(2*time.Hour + 500*time.Millisecond)
	if got := checker.Check(context.Background()).UptimeSeconds; got != 7290 {
		t.Errorf("UptimeSeconds after advancing 2h0.5s = %d, want 7290", got)
	}
}

func TestReportIsOKWhenEveryStoreIsUp(t *testing.T) {
	checker := health.NewChecker(clock.NewFake(start), stubDatabase{version: 7}, stubPinger{}, stubPinger{})

	report := checker.Check(context.Background())

	if !report.OK() {
		t.Fatalf("report not OK: %+v", report)
	}
	if report.Database.SchemaVersion != 7 {
		t.Errorf("SchemaVersion = %d, want 7", report.Database.SchemaVersion)
	}
}

func TestReportIsDegradedWhenAnyStoreIsDown(t *testing.T) {
	down := errors.New("connection refused")
	cases := map[string]*health.Checker{
		"database":       health.NewChecker(clock.NewFake(start), stubDatabase{err: down}, stubPinger{}, stubPinger{}),
		"object storage": health.NewChecker(clock.NewFake(start), stubDatabase{version: 1}, stubPinger{err: down}, stubPinger{}),
		"cache":          health.NewChecker(clock.NewFake(start), stubDatabase{version: 1}, stubPinger{}, stubPinger{err: down}),
	}
	for name, checker := range cases {
		t.Run(name, func(t *testing.T) {
			report := checker.Check(context.Background())
			if report.OK() {
				t.Fatalf("report OK with %s down: %+v", name, report)
			}
		})
	}
}
