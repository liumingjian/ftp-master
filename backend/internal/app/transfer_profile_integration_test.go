//go:build integration

package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/liumingjian/ftp-master/backend/internal/scheduler"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// pacedReader advances the fake clock as chunks are read so the server records
// multi-second Transfer Profile curves deterministically without sleeping.
type pacedReader struct {
	data         []byte
	offset       int
	stepBytes    int
	sinceStep    int
	step         time.Duration
	clk          *clock.Fake
}

func (p *pacedReader) Read(buf []byte) (int, error) {
	if p.offset >= len(p.data) {
		return 0, io.EOF
	}
	remaining := len(p.data) - p.offset
	limit := len(buf)
	if limit > remaining {
		limit = remaining
	}
	if p.stepBytes > 0 {
		untilStep := p.stepBytes - p.sinceStep
		if untilStep > 0 && limit > untilStep {
			limit = untilStep
		}
	}
	n := copy(buf[:limit], p.data[p.offset:p.offset+limit])
	p.offset += n
	p.sinceStep += n
	if p.stepBytes > 0 && p.sinceStep >= p.stepBytes && p.offset < len(p.data) {
		p.sinceStep = 0
		p.clk.Advance(p.step)
	}
	return n, nil
}

func TestTransferProfileUploadDownloadRangeSeriesAndFilters(t *testing.T) {
	stores := startStores(t)
	clk := clock.NewFake(time.Date(2026, 11, 24, 6, 0, 0, 0, time.UTC))
	server := startService(t, stores.config, clk)
	admin := newBrowser(t, server)
	signInAsAdministrator(t, admin)

	call := func(b *browser, method, path string, body any, want int) []byte {
		t.Helper()
		status, data := b.do(method, path, body)
		if status != want {
			t.Fatalf("%s %s: got %d want %d: %s", method, path, status, want, data)
		}
		return data
	}

	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/api/tree", map[string]any{"name": "Transfers"}, 201), &dir)

	// 1. Multipart upload across 2 parts with a collapsed 30-second resume pause.
	content := bytes.Repeat([]byte("0123456789ABCDEF"), 512*1024+16) // >8 MiB -> 2 parts
	var upload struct {
		ID        string `json:"id"`
		PartSize  int64  `json:"partSize"`
		PartCount int    `json:"partCount"`
	}
	decode(t, call(admin, "POST", "/api/uploads", map[string]any{"parentId": dir.ID, "name": "big.bin", "size": len(content)}, 201), &upload)
	var urls []struct {
		Number int    `json:"number"`
		URL    string `json:"url"`
	}
	decode(t, call(admin, "POST", "/api/uploads/"+upload.ID+"/parts", map[string]any{"numbers": []int{1, 2}}, 200), &urls)

	// Stream part 1 over ~4 simulated seconds (2 MiB per second).
	p1 := &pacedReader{data: content[:upload.PartSize], stepBytes: 2 * 1024 * 1024, step: time.Second, clk: clk}
	req, _ := http.NewRequest("PUT", server.URL+urls[0].URL, p1)
	req.ContentLength = upload.PartSize
	req.AddCookie(admin.cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("part 1 status %d", res.StatusCode)
	}

	// Simulate a 30-second resume pause (>10s threshold -> collapsed gap).
	clk.Advance(30 * time.Second)

	// Stream part 2 over ~2 simulated seconds.
	part2Bytes := content[upload.PartSize:]
	p2 := &pacedReader{data: part2Bytes, stepBytes: max(1, len(part2Bytes)/2), step: time.Second, clk: clk}
	req, _ = http.NewRequest("PUT", server.URL+urls[1].URL, p2)
	req.ContentLength = int64(len(part2Bytes))
	req.AddCookie(admin.cookie)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("part 2 status %d", res.StatusCode)
	}

	var published struct {
		FileID int64 `json:"fileId"`
	}
	decode(t, call(admin, "POST", "/api/uploads/"+upload.ID+"/complete", nil, 200), &published)

	// 2. Partial HTTP Range download + invalid 416 check.
	rangeReq, _ := http.NewRequest("GET", fmt.Sprintf("%s/api/tree/%d/download", server.URL, published.FileID), nil)
	rangeReq.Header.Set("Range", "bytes=100-1099")
	rangeReq.AddCookie(admin.cookie)
	rangeRes, err := http.DefaultClient.Do(rangeReq)
	if err != nil {
		t.Fatal(err)
	}
	gotRange, _ := io.ReadAll(rangeRes.Body)
	rangeRes.Body.Close()
	if rangeRes.StatusCode != 206 || len(gotRange) != 1000 || !bytes.Equal(gotRange, content[100:1100]) {
		t.Fatalf("range download: status=%d len=%d", rangeRes.StatusCode, len(gotRange))
	}

	badRangeReq, _ := http.NewRequest("GET", fmt.Sprintf("%s/api/tree/%d/download", server.URL, published.FileID), nil)
	badRangeReq.Header.Set("Range", "bytes=999999999-")
	badRangeReq.AddCookie(admin.cookie)
	badRangeRes, err := http.DefaultClient.Do(badRangeReq)
	if err != nil {
		t.Fatal(err)
	}
	badRangeRes.Body.Close()
	if badRangeRes.StatusCode != 416 {
		t.Fatalf("invalid range status=%d", badRangeRes.StatusCode)
	}

	// 3. Interrupted part upload immediately records an upload failure event.
	var broken struct {
		ID string `json:"id"`
	}
	decode(t, call(admin, "POST", "/api/uploads", map[string]any{"parentId": dir.ID, "name": "broken.bin", "size": 1000}, 201), &broken)
	brokenReq, _ := http.NewRequest("PUT", server.URL+"/api/uploads/"+broken.ID+"/parts/1", bytes.NewReader([]byte("short")))
	brokenReq.AddCookie(admin.cookie)
	brokenRes, err := http.DefaultClient.Do(brokenReq)
	if err != nil {
		t.Fatal(err)
	}
	brokenRes.Body.Close()
	if brokenRes.StatusCode != 400 {
		t.Fatalf("broken part status=%d", brokenRes.StatusCode)
	}

	// 4. Query audit with category=transfer, anomaliesOnly, and inspect series + CSV.
	queryBody := map[string]any{
		"from":     "2026-11-24T05:00:00Z",
		"to":       "2026-11-24T08:00:00Z",
		"category": "transfer",
	}
	var queryRes struct {
		Total  int `json:"total"`
		Events []struct {
			ID      int64           `json:"id"`
			Time    string          `json:"time"`
			Action  string          `json:"action"`
			Outcome string          `json:"outcome"`
			Path    string          `json:"path"`
			Detail  json.RawMessage `json:"detail"`
		} `json:"events"`
	}
	decode(t, call(admin, "POST", "/api/audit/query", queryBody, 200), &queryRes)
	if queryRes.Total != 3 {
		t.Fatalf("expected 3 transfer events (upload ok, download range ok, upload fail), got %d", queryRes.Total)
	}

	// Find the completed big.bin upload and verify its Transfer Profile & series endpoint.
	var uploadEventID int64
	var uploadEventTime string
	var rangeDownloadChecked bool
	for _, ev := range queryRes.Events {
		var d struct {
			TransferProfile *audit.TransferProfileSummary `json:"transferProfile"`
		}
		decode(t, ev.Detail, &d)
		if d.TransferProfile == nil {
			t.Fatalf("event %d (%s) missing transferProfile", ev.ID, ev.Action)
		}
		if ev.Action == "upload" && ev.Outcome == "success" {
			uploadEventID = ev.ID
			uploadEventTime = ev.Time
			if len(d.TransferProfile.Sparkline) < 2 {
				t.Fatalf("expected non-empty sparkline for multi-second upload, got %+v", d.TransferProfile)
			}
			if d.TransferProfile.TotalSpanMs <= d.TransferProfile.ActiveDurationMs+20000 {
				t.Fatalf("expected collapsed pause reflected in totalSpanMs > activeDurationMs: %+v", d.TransferProfile)
			}
		}
		if ev.Action == "download" && d.TransferProfile.Range != nil {
			if d.TransferProfile.Range.Start == 100 && d.TransferProfile.Range.End == 1099 {
				rangeDownloadChecked = true
			}
		}
	}
	if uploadEventID == 0 || !rangeDownloadChecked {
		t.Fatalf("missing expected transfer events: uploadID=%d range=%v", uploadEventID, rangeDownloadChecked)
	}

	var series audit.TransferSeries
	decode(t, call(admin, "GET", fmt.Sprintf("/api/audit/%d/transfer-series?occurredAt=%s", uploadEventID, url.QueryEscape(uploadEventTime)), nil, 200), &series)
	if len(series.Points) < 2 || len(series.Gaps) != 1 || series.Gaps[0].DurationSeconds < 25 {
		t.Fatalf("unexpected transfer series: %+v", series)
	}

	// Filter anomaliesOnly -> returns only the failed upload.
	queryBody["anomaliesOnly"] = true
	decode(t, call(admin, "POST", "/api/audit/query", queryBody, 200), &queryRes)
	if queryRes.Total != 1 || queryRes.Events[0].Outcome != "failure" {
		t.Fatalf("anomaliesOnly filter mismatch: %+v", queryRes)
	}
	delete(queryBody, "anomaliesOnly")

	// CSV export includes summary columns and strips sparkline array.
	queryBody["export"] = true
	csvBytes := call(admin, "POST", "/api/audit/query", queryBody, 200)
	csvText := string(csvBytes)
	if !strings.Contains(csvText, "bytes_transferred,total_bytes,active_duration_ms,avg_bps,peak_bps,min_bps,anomaly") {
		t.Fatalf("CSV missing transfer summary columns: %s", csvText)
	}
	if strings.Contains(csvText, `"sparkline"`) {
		t.Fatalf("CSV should omit sparkline array: %s", csvText)
	}

	// 5. Abandoned upload (>0 bytes transferred) emits failure audit on scheduler cleanup.
	var abandoned struct {
		ID string `json:"id"`
	}
	decode(t, call(admin, "POST", "/api/uploads", map[string]any{"parentId": dir.ID, "name": "abandoned.bin", "size": int(upload.PartSize) + 10}, 201), &abandoned)
	abReq, _ := http.NewRequest("PUT", server.URL+"/api/uploads/"+abandoned.ID+"/parts/1", bytes.NewReader(content[:upload.PartSize]))
	abReq.AddCookie(admin.cookie)
	abRes, err := http.DefaultClient.Do(abReq)
	if err != nil {
		t.Fatal(err)
	}
	abRes.Body.Close()
	if abRes.StatusCode != 200 {
		t.Fatalf("abandoned part 1 status %d", abRes.StatusCode)
	}

	clk.Advance(25 * time.Hour)
	pool, err := pgxpool.New(context.Background(), stores.config.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	mc, err := minio.New(stores.config.MinIOEndpoint, &minio.Options{Creds: credentials.NewStaticV4(stores.config.MinIOAccessKey, stores.config.MinIOSecretKey, "")})
	if err != nil {
		t.Fatal(err)
	}
	if err := scheduler.New(pool, mc, stores.config.MinIOBucket, clk).Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	var abandonedCount int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_events WHERE action='upload' AND outcome='failure' AND detail->>'reason' LIKE '%放弃%'`).Scan(&abandonedCount); err != nil || abandonedCount != 1 {
		t.Fatalf("expected 1 abandoned upload audit event, got %d err %v", abandonedCount, err)
	}
}
