package audit_test

import (
	"testing"
	"time"

	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
)

func TestTransferProfileInstantTransferOmitsSeriesAndSparkline(t *testing.T) {
	base := time.Date(2026, 11, 24, 6, 0, 0, 0, time.UTC)
	clk := clock.NewFake(base)
	sampler := audit.NewTransferSampler(clk)
	sampler.Add(184 * 1024)
	clk.Advance(42 * time.Millisecond)
	seg := sampler.Finish()

	summary, series := audit.BuildTransferProfile([]audit.TransferSegment{seg}, 184*1024, false, "", nil)
	if series != nil {
		t.Fatalf("expected nil series for instant transfer, got %d points", len(series.Points))
	}
	if len(summary.Sparkline) != 0 {
		t.Fatalf("expected empty sparkline for instant transfer, got %v", summary.Sparkline)
	}
	if summary.BytesTransferred != 184*1024 || summary.ActiveDurationMs != 42 || summary.Anomaly != audit.AnomalyNone {
		t.Fatalf("unexpected instant summary: %+v", summary)
	}
}

func TestTransferProfileDetectsStallAndIgnoresTrailingSecond(t *testing.T) {
	base := time.Date(2026, 11, 24, 6, 0, 0, 0, time.UTC)
	const mb = 1024 * 1024
	samples := make([]audit.RawSecondSample, 0, 12)
	for i := 0; i < 12; i++ {
		bps := int64(20 * mb)
		if i >= 4 && i <= 6 {
			bps = 512 * 1024 // <15% for 3 consecutive seconds -> stall
		}
		if i == 11 {
			bps = 100 * 1024 // trailing partial second should not create a second stall
		}
		samples = append(samples, audit.RawSecondSample{
			SecondUnix: base.Add(time.Duration(i) * time.Second).Unix(),
			Bytes:      bps,
		})
	}
	seg := audit.TransferSegment{
		StartedAt:        base,
		EndedAt:          base.Add(11 * time.Second),
		BytesTransferred: 9*20*mb + 3*512*1024 + 100*1024,
		Samples:          samples,
	}

	summary, series := audit.BuildTransferProfile([]audit.TransferSegment{seg}, seg.BytesTransferred, false, "", nil)
	if series == nil || len(series.Points) != 12 {
		t.Fatalf("expected 12 points, got %+v", series)
	}
	if summary.Anomaly != audit.AnomalyStall || summary.StallCount != 1 {
		t.Fatalf("expected stallCount=1, got %+v", summary)
	}
	for i := 4; i <= 6; i++ {
		if !series.Points[i].Stalled {
			t.Fatalf("expected point %d to be marked stalled", i)
		}
	}
	if series.Points[11].Stalled {
		t.Fatalf("trailing partial second should not be marked stalled")
	}
}

func TestTransferProfileCollapsesResumePauseGreaterThan10Seconds(t *testing.T) {
	base := time.Date(2026, 11, 24, 6, 0, 0, 0, time.UTC)
	const mb = 1024 * 1024

	part1 := audit.TransferSegment{
		StartedAt:        base,
		EndedAt:          base.Add(4 * time.Second),
		BytesTransferred: 40 * mb,
		Samples: []audit.RawSecondSample{
			{SecondUnix: base.Unix(), Bytes: 10 * mb},
			{SecondUnix: base.Add(1 * time.Second).Unix(), Bytes: 10 * mb},
			{SecondUnix: base.Add(2 * time.Second).Unix(), Bytes: 10 * mb},
			{SecondUnix: base.Add(3 * time.Second).Unix(), Bytes: 10 * mb},
		},
	}
	// Pause for 120 seconds before resuming part 2.
	resumeAt := base.Add(124 * time.Second)
	part2 := audit.TransferSegment{
		StartedAt:        resumeAt,
		EndedAt:          resumeAt.Add(3 * time.Second),
		BytesTransferred: 30 * mb,
		Samples: []audit.RawSecondSample{
			{SecondUnix: resumeAt.Unix(), Bytes: 10 * mb},
			{SecondUnix: resumeAt.Add(1 * time.Second).Unix(), Bytes: 10 * mb},
			{SecondUnix: resumeAt.Add(2 * time.Second).Unix(), Bytes: 10 * mb},
		},
	}

	summary, series := audit.BuildTransferProfile([]audit.TransferSegment{part1, part2}, 70*mb, false, "", nil)
	if series == nil {
		t.Fatal("expected non-nil series")
	}
	if len(series.Gaps) != 1 {
		t.Fatalf("expected 1 collapsed gap, got %+v", series.Gaps)
	}
	if series.Gaps[0].BeforeIndex != 4 || series.Gaps[0].DurationSeconds != 120 {
		t.Fatalf("unexpected gap: %+v", series.Gaps[0])
	}
	if summary.ActiveDurationMs != 7000 || summary.TotalSpanMs != 127000 {
		t.Fatalf("expected active=7000ms totalSpan=127000ms, got %+v", summary)
	}
	if summary.Anomaly != audit.AnomalyNone {
		t.Fatalf("collapsed resume pause must not be flagged as stall, got %+v", summary)
	}
}

func TestTransferProfileDownsamplesLongTransfersOverOneHour(t *testing.T) {
	base := time.Date(2026, 11, 24, 4, 0, 0, 0, time.UTC)
	const mb = 1024 * 1024
	const totalSec = 4800 // 1h20m -> bucketSeconds=5, 960 points
	samples := make([]audit.RawSecondSample, totalSec)
	for i := 0; i < totalSec; i++ {
		samples[i] = audit.RawSecondSample{
			SecondUnix: base.Add(time.Duration(i) * time.Second).Unix(),
			Bytes:      4 * mb,
		}
	}
	seg := audit.TransferSegment{
		StartedAt:        base,
		EndedAt:          base.Add(time.Duration(totalSec) * time.Second),
		BytesTransferred: int64(totalSec) * 4 * mb,
		Samples:          samples,
	}

	summary, series := audit.BuildTransferProfile([]audit.TransferSegment{seg}, seg.BytesTransferred, false, "", nil)
	if series == nil {
		t.Fatal("expected series")
	}
	if summary.BucketSeconds != 5 || series.BucketSeconds != 5 {
		t.Fatalf("expected 5s buckets, got summary=%d series=%d", summary.BucketSeconds, series.BucketSeconds)
	}
	if len(series.Points) != 960 {
		t.Fatalf("expected 960 downsampled points, got %d", len(series.Points))
	}
	if len(summary.Sparkline) != 24 {
		t.Fatalf("expected 24 sparkline buckets, got %d", len(summary.Sparkline))
	}
}
