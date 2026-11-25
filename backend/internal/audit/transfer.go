package audit

import (
	"encoding/json"
	"io"
	"math"
	"sort"
	"sync"
	"time"

	"github.com/liumingjian/ftp-master/backend/internal/clock"
)

// TransferAnomaly classifies throughput health on a Transfer Profile.
type TransferAnomaly string

const (
	AnomalyNone   TransferAnomaly = "none"
	AnomalyStall  TransferAnomaly = "stall"
	AnomalyFailed TransferAnomaly = "failed"
)

const (
	pauseCollapseThresholdSec = 10
	maxSeriesPoints           = 3600
	maxSparklineBuckets       = 24
)

// TransferRange records the inclusive byte bounds of a partial HTTP Range download.
type TransferRange struct {
	Start int64 `json:"start"`
	End   int64 `json:"end"`
}

// TransferSamplePoint is one throughput bucket in a Transfer Profile time series.
type TransferSamplePoint struct {
	Index           int       `json:"index"`
	Timestamp       time.Time `json:"timestamp"`
	Bps             int64     `json:"bps"`
	CumulativeBytes int64     `json:"cumulativeBytes"`
	Stalled         bool      `json:"stalled,omitempty"`
}

// TransferGap marks a collapsed >10s pause between resumable upload parts.
type TransferGap struct {
	BeforeIndex     int       `json:"beforeIndex"`
	DurationSeconds int       `json:"durationSeconds"`
	StartedAt       time.Time `json:"startedAt"`
	ResumedAt       time.Time `json:"resumedAt"`
}

// TransferProfileSummary is stored inline in audit_events.detail.transferProfile
// so paged audit lists and CSV exports never need to scan full time-series rows.
type TransferProfileSummary struct {
	BytesTransferred int64           `json:"bytesTransferred"`
	TotalBytes       int64           `json:"totalBytes"`
	ActiveDurationMs int64           `json:"activeDurationMs"`
	TotalSpanMs      int64           `json:"totalSpanMs"`
	AvgBps           int64           `json:"avgBps"`
	PeakBps          int64           `json:"peakBps"`
	MinBps           int64           `json:"minBps"`
	Anomaly          TransferAnomaly `json:"anomaly"`
	StallCount       int             `json:"stallCount,omitempty"`
	StatusReason     string          `json:"statusReason,omitempty"`
	Range            *TransferRange  `json:"range,omitempty"`
	BucketSeconds    int             `json:"bucketSeconds"`
	Sparkline        []int64         `json:"sparkline"`
}

// TransferSeries holds the full time-series points and pause markers stored in
// audit_transfer_series and fetched on demand for the throughput trend window.
type TransferSeries struct {
	BucketSeconds int                   `json:"bucketSeconds"`
	Points        []TransferSamplePoint `json:"points"`
	Gaps          []TransferGap         `json:"gaps"`
}

// RawSecondSample is one per-second byte count recorded while streaming a transfer.
type RawSecondSample struct {
	SecondUnix int64 `json:"s"`
	Bytes      int64 `json:"b"`
}

// TransferSegment represents one continuous HTTP transfer stream (an entire
// download, zip stream, or one multipart upload part).
type TransferSegment struct {
	StartedAt        time.Time
	EndedAt          time.Time
	BytesTransferred int64
	Samples          []RawSecondSample
}

// TransferSampler records per-second byte counts while a stream runs, reading
// all timestamps through the injected clock.Clock.
type TransferSampler struct {
	clock   clock.Clock
	mu      sync.Mutex
	started time.Time
	ended   time.Time
	total   int64
	buckets map[int64]int64
}

// NewTransferSampler starts a sampler stamped at clk.Now().
func NewTransferSampler(clk clock.Clock) *TransferSampler {
	now := clk.Now().UTC()
	return &TransferSampler{
		clock:   clk,
		started: now,
		ended:   now,
		buckets: map[int64]int64{},
	}
}

// Add records n transferred bytes at the current clock timestamp.
func (s *TransferSampler) Add(n int64) {
	if n <= 0 {
		return
	}
	now := s.clock.Now().UTC()
	sec := now.Unix()
	s.mu.Lock()
	s.total += n
	s.buckets[sec] += n
	if now.After(s.ended) {
		s.ended = now
	}
	s.mu.Unlock()
}

// Bytes returns the cumulative bytes observed so far.
func (s *TransferSampler) Bytes() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.total
}

// Finish closes the segment at clk.Now() and fills every second in the active
// stream span so mid-stream stalls show as explicit 0 B/s seconds.
func (s *TransferSampler) Finish() TransferSegment {
	now := s.clock.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	if now.After(s.ended) {
		s.ended = now
	}
	startSec := s.started.Unix()
	endSec := s.ended.Unix()
	if endSec < startSec {
		endSec = startSec
	}
	samples := make([]RawSecondSample, 0, endSec-startSec+1)
	for sec := startSec; sec <= endSec; sec++ {
		samples = append(samples, RawSecondSample{
			SecondUnix: sec,
			Bytes:      s.buckets[sec],
		})
	}
	return TransferSegment{
		StartedAt:        s.started,
		EndedAt:          s.ended,
		BytesTransferred: s.total,
		Samples:          samples,
	}
}

// CountingReader wraps r and feeds every read byte count into s.
func (s *TransferSampler) CountingReader(r io.Reader) io.Reader {
	return &countingReader{r: r, sampler: s}
}

// CountingWriter wraps w and feeds every written byte count into s.
func (s *TransferSampler) CountingWriter(w io.Writer) io.Writer {
	return &countingWriter{w: w, sampler: s}
}

type countingReader struct {
	r       io.Reader
	sampler *TransferSampler
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	if n > 0 {
		c.sampler.Add(int64(n))
	}
	return n, err
}

type countingWriter struct {
	w       io.Writer
	sampler *TransferSampler
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	if n > 0 {
		c.sampler.Add(int64(n))
	}
	return n, err
}

// EncodeRawSamples serializes raw per-second samples for transient DB storage.
func EncodeRawSamples(samples []RawSecondSample) ([]byte, error) {
	if samples == nil {
		samples = []RawSecondSample{}
	}
	return json.Marshal(samples)
}

// DecodeRawSamples deserializes raw per-second samples from transient DB storage.
func DecodeRawSamples(raw []byte) ([]RawSecondSample, error) {
	var out []RawSecondSample
	if len(raw) == 0 {
		return out, nil
	}
	err := json.Unmarshal(raw, &out)
	return out, err
}

// BuildTransferProfile merges one or more transfer segments into an inline
// summary (for audit_events.detail) and an optional full time-series (for
// audit_transfer_series). Transfers shorter than 2 seconds return a nil series
// and an empty sparkline.
func BuildTransferProfile(
	segments []TransferSegment,
	totalBytes int64,
	failed bool,
	statusReason string,
	byteRange *TransferRange,
) (TransferProfileSummary, *TransferSeries) {
	summary := TransferProfileSummary{
		TotalBytes:    totalBytes,
		Anomaly:       AnomalyNone,
		StatusReason:  statusReason,
		Range:         byteRange,
		BucketSeconds: 1,
		Sparkline:     []int64{},
	}
	if failed {
		summary.Anomaly = AnomalyFailed
	}
	if len(segments) == 0 {
		return summary, nil
	}

	sorted := make([]TransferSegment, len(segments))
	copy(sorted, segments)
	sort.Slice(sorted, func(i, j int) bool {
		if !sorted[i].StartedAt.Equal(sorted[j].StartedAt) {
			return sorted[i].StartedAt.Before(sorted[j].StartedAt)
		}
		return sorted[i].EndedAt.Before(sorted[j].EndedAt)
	})

	var bytesTransferred int64
	for _, seg := range sorted {
		bytesTransferred += seg.BytesTransferred
	}
	if totalBytes <= 0 {
		totalBytes = bytesTransferred
	}
	summary.BytesTransferred = bytesTransferred
	summary.TotalBytes = totalBytes

	firstStart := sorted[0].StartedAt.UTC()
	lastEnd := sorted[0].EndedAt.UTC()
	for _, seg := range sorted[1:] {
		if seg.EndedAt.After(lastEnd) {
			lastEnd = seg.EndedAt.UTC()
		}
	}

	type rawPoint struct {
		sec   int64
		bytes int64
	}
	rawPoints := make([]rawPoint, 0, 64)
	gaps := make([]TransferGap, 0)
	var collapsedPauseMs int64

	var prevEnd time.Time
	hasPrev := false
	for _, seg := range sorted {
		segSamples := seg.Samples
		if len(segSamples) == 0 {
			segSamples = []RawSecondSample{{SecondUnix: seg.StartedAt.UTC().Unix(), Bytes: seg.BytesTransferred}}
		}
		sort.Slice(segSamples, func(i, j int) bool {
			return segSamples[i].SecondUnix < segSamples[j].SecondUnix
		})

		if hasPrev {
			gapMs := seg.StartedAt.Sub(prevEnd).Milliseconds()
			if gapMs > int64(pauseCollapseThresholdSec)*1000 {
				gapSec := int(math.Round(float64(gapMs) / 1000.0))
				if gapSec < pauseCollapseThresholdSec+1 {
					gapSec = pauseCollapseThresholdSec + 1
				}
				gaps = append(gaps, TransferGap{
					BeforeIndex:     len(rawPoints),
					DurationSeconds: gapSec,
					StartedAt:       prevEnd.UTC(),
					ResumedAt:       seg.StartedAt.UTC(),
				})
				collapsedPauseMs += gapMs
			} else if len(rawPoints) > 0 {
				// Fill brief inter-part silence (<=10s) as explicit 0 B/s seconds.
				lastSec := rawPoints[len(rawPoints)-1].sec
				nextFirstSec := segSamples[0].SecondUnix
				for fill := lastSec + 1; fill < nextFirstSec; fill++ {
					rawPoints = append(rawPoints, rawPoint{sec: fill, bytes: 0})
				}
			}
		}

		for _, sample := range segSamples {
			if len(rawPoints) > 0 && rawPoints[len(rawPoints)-1].sec == sample.SecondUnix && !gapAt(gaps, len(rawPoints)) {
				rawPoints[len(rawPoints)-1].bytes += sample.Bytes
				continue
			}
			if len(rawPoints) > 0 && sample.SecondUnix < rawPoints[len(rawPoints)-1].sec {
				// Out-of-order concurrent part sample: accumulate into existing matching second if present.
				merged := false
				for idx := len(rawPoints) - 1; idx >= 0 && rawPoints[idx].sec >= sample.SecondUnix; idx-- {
					if rawPoints[idx].sec == sample.SecondUnix {
						rawPoints[idx].bytes += sample.Bytes
						merged = true
						break
					}
				}
				if merged {
					continue
				}
			}
			rawPoints = append(rawPoints, rawPoint{sec: sample.SecondUnix, bytes: sample.Bytes})
		}

		if !hasPrev || seg.EndedAt.After(prevEnd) {
			prevEnd = seg.EndedAt.UTC()
		}
		hasPrev = true
	}

	totalSpanMs := lastEnd.Sub(firstStart).Milliseconds()
	if totalSpanMs < 1 {
		totalSpanMs = 1
	}
	activeDurationMs := totalSpanMs - collapsedPauseMs
	if activeDurationMs < 1 {
		activeDurationMs = 1
	}
	summary.TotalSpanMs = totalSpanMs
	summary.ActiveDurationMs = activeDurationMs

	avgBps := int64(math.Round(float64(bytesTransferred) / (float64(activeDurationMs) / 1000.0)))
	summary.AvgBps = avgBps

	// Instant transfers (<2s or <2 active points) record only summary metrics.
	if activeDurationMs < 2000 || len(rawPoints) < 2 {
		summary.PeakBps = avgBps
		summary.MinBps = avgBps
		return summary, nil
	}

	// Build 1-second TransferSamplePoints with cumulative byte totals.
	points := make([]TransferSamplePoint, len(rawPoints))
	var cumulative int64
	var peakBps int64
	minBps := int64(math.MaxInt64)
	for i, rp := range rawPoints {
		bps := rp.bytes
		if bps < 0 {
			bps = 0
		}
		cumulative += bps
		if totalBytes > 0 && cumulative > totalBytes {
			cumulative = totalBytes
		}
		if bps > peakBps {
			peakBps = bps
		}
		if bps < minBps {
			minBps = bps
		}
		points[i] = TransferSamplePoint{
			Index:           i,
			Timestamp:       time.Unix(rp.sec, 0).UTC(),
			Bps:             bps,
			CumulativeBytes: cumulative,
		}
	}
	if minBps == math.MaxInt64 {
		minBps = 0
	}
	summary.PeakBps = peakBps
	summary.MinBps = minBps

	// Relative stall detection (ADR / Q9):
	// >=3 consecutive active seconds (excluding final trailing second) at 0 B/s
	// or <15% of both/either peak and average speed.
	gapStarts := map[int]bool{}
	for _, g := range gaps {
		gapStarts[g.BeforeIndex] = true
	}
	isLow := func(bps int64) bool {
		if bps == 0 {
			return true
		}
		if peakBps > 0 && bps*100 < peakBps*15 {
			return true
		}
		if avgBps > 0 && bps*100 < avgBps*15 {
			return true
		}
		return false
	}

	stallLimit := len(points) - 1 // exclude final partial second for successful transfers
	if failed {
		stallLimit = len(points)
	}
	stallCount := 0
	runStart := -1
	flushRun := func(endExclusive int) {
		if runStart < 0 {
			return
		}
		if endExclusive-runStart >= 3 {
			stallCount++
			for k := runStart; k < endExclusive; k++ {
				points[k].Stalled = true
			}
		}
		runStart = -1
	}
	if peakBps > 0 || failed {
		for i := 0; i < stallLimit; i++ {
			if gapStarts[i] {
				flushRun(i)
			}
			if isLow(points[i].Bps) {
				if runStart < 0 {
					runStart = i
				}
			} else {
				flushRun(i)
			}
		}
		flushRun(stallLimit)
	}
	if !failed && stallCount > 0 {
		summary.Anomaly = AnomalyStall
		summary.StallCount = stallCount
	}

	// Downsample transfers longer than 1 hour (>3600 points) to keep series bounded.
	bucketSeconds := chooseBucketWidth(len(points))
	if bucketSeconds > 1 {
		points, gaps = coarsenSeries(points, gaps, bucketSeconds)
	}
	summary.BucketSeconds = bucketSeconds

	// Build bounded sparkline (<=24 buckets) for audit_events.detail.
	summary.Sparkline = buildSparkline(points, maxSparklineBuckets)

	return summary, &TransferSeries{
		BucketSeconds: bucketSeconds,
		Points:        points,
		Gaps:          gaps,
	}
}

func gapAt(gaps []TransferGap, idx int) bool {
	for _, g := range gaps {
		if g.BeforeIndex == idx {
			return true
		}
	}
	return false
}

func chooseBucketWidth(pointCount int) int {
	if pointCount <= maxSeriesPoints {
		return 1
	}
	for _, candidate := range []int{5, 10, 15, 30, 60, 120, 300} {
		if (pointCount+candidate-1)/candidate <= maxSeriesPoints {
			return candidate
		}
	}
	return (pointCount + maxSeriesPoints - 1) / maxSeriesPoints
}

func coarsenSeries(points []TransferSamplePoint, gaps []TransferGap, bucketSeconds int) ([]TransferSamplePoint, []TransferGap) {
	gapByIdx := map[int]TransferGap{}
	for _, g := range gaps {
		gapByIdx[g.BeforeIndex] = g
	}

	outPoints := make([]TransferSamplePoint, 0, (len(points)+bucketSeconds-1)/bucketSeconds)
	outGaps := make([]TransferGap, 0, len(gaps))

	i := 0
	for i < len(points) {
		if g, ok := gapByIdx[i]; ok {
			g.BeforeIndex = len(outPoints)
			outGaps = append(outGaps, g)
		}
		end := i + bucketSeconds
		if end > len(points) {
			end = len(points)
		}
		// Never merge points across a collapsed pause boundary.
		for k := i + 1; k < end; k++ {
			if _, ok := gapByIdx[k]; ok {
				end = k
				break
			}
		}
		var sumBps int64
		stalled := false
		for k := i; k < end; k++ {
			sumBps += points[k].Bps
			if points[k].Stalled {
				stalled = true
			}
		}
		count := int64(end - i)
		outPoints = append(outPoints, TransferSamplePoint{
			Index:           len(outPoints),
			Timestamp:       points[i].Timestamp,
			Bps:             sumBps / count,
			CumulativeBytes: points[end-1].CumulativeBytes,
			Stalled:         stalled,
		})
		i = end
	}
	return outPoints, outGaps
}

func buildSparkline(points []TransferSamplePoint, maxBuckets int) []int64 {
	if len(points) == 0 {
		return []int64{}
	}
	if len(points) <= maxBuckets {
		out := make([]int64, len(points))
		for i, p := range points {
			out[i] = p.Bps
		}
		return out
	}
	out := make([]int64, 0, maxBuckets)
	step := float64(len(points)) / float64(maxBuckets)
	for i := 0; i < maxBuckets; i++ {
		start := int(math.Floor(float64(i) * step))
		end := int(math.Floor(float64(i+1) * step))
		if end <= start {
			end = start + 1
		}
		if end > len(points) {
			end = len(points)
		}
		var sum int64
		for j := start; j < end; j++ {
			sum += points[j].Bps
		}
		out = append(out, sum/int64(end-start))
	}
	return out
}
