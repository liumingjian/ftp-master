//go:build integration

package app_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

func TestCancelSingleFileUploadAbortsMultipartAndEnforcesOwnershipAndState(t *testing.T) {
	stores := startStores(t)
	ctx := context.Background()
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
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

	conn, err := pgx.Connect(ctx, stores.config.MigrationDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	var actorID int64
	err = conn.QueryRow(ctx, `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT 'cancel-user','Cancel User',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`).Scan(&actorID)
	if err != nil {
		t.Fatal(err)
	}
	actor := newBrowser(t, server)
	if status, _ := actor.signIn("cancel-user", initialAdministratorPassword); status != 200 {
		t.Fatalf("sign in actor: %d", status)
	}

	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/api/tree", map[string]any{"name": "CancelSingle"}, 201), &dir)
	var grant struct {
		ID int64 `json:"id"`
	}
	// Browse + Download + Upload so actor can upload, resolve conflicts, and verify downloads.
	decode(t, call(admin, "POST", fmt.Sprintf("/api/tree/%d/grants", dir.ID), map[string]any{
		"principalKind": "user",
		"principalId":   actorID,
		"rights":        7,
		"scope":         "subtree",
	}, 201), &grant)

	client, err := minio.New(stores.config.MinIOEndpoint, &minio.Options{
		Creds: credentials.NewStaticV4(stores.config.MinIOAccessKey, stores.config.MinIOSecretKey, ""),
	})
	if err != nil {
		t.Fatal(err)
	}

	countIncomplete := func() int {
		t.Helper()
		n := 0
		for u := range client.ListIncompleteUploads(ctx, stores.config.MinIOBucket, "", true) {
			if u.Err != nil {
				t.Fatal(u.Err)
			}
			n++
		}
		return n
	}
	countObjects := func() int {
		t.Helper()
		n := 0
		for o := range client.ListObjects(ctx, stores.config.MinIOBucket, minio.ListObjectsOptions{}) {
			if o.Err != nil {
				t.Fatal(o.Err)
			}
			n++
		}
		return n
	}

	// Unknown ID returns 404.
	call(actor, "DELETE", "/api/uploads/does-not-exist", nil, 404)

	// Start a 2-part upload and transfer part 1 (creating MinIO multipart parts and transfer samples).
	content := bytes.Repeat([]byte("partdata"), 1024*1024+16) // > 8 MiB (2 parts)
	var pending struct {
		ID        string  `json:"id"`
		PartSize  int64   `json:"partSize"`
		PartCount int     `json:"partCount"`
		BatchID   *string `json:"batchId"`
	}
	decode(t, call(actor, "POST", "/api/uploads", map[string]any{
		"parentId": dir.ID,
		"name":     "aborted.bin",
		"size":     len(content),
	}, 201), &pending)
	if pending.BatchID != nil {
		t.Fatalf("single-file upload unexpectedly returned batchId %q", *pending.BatchID)
	}
	var urls []struct {
		Number int    `json:"number"`
		URL    string `json:"url"`
	}
	decode(t, call(actor, "POST", "/api/uploads/"+pending.ID+"/parts", map[string]any{"numbers": []int{1}}, 200), &urls)
	req, _ := http.NewRequest("PUT", server.URL+urls[0].URL, bytes.NewReader(content[:pending.PartSize]))
	req.AddCookie(actor.cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("part 1 status: %d", res.StatusCode)
	}
	if got := countIncomplete(); got != 1 {
		t.Fatalf("expected 1 incomplete multipart upload before cancel, got %d", got)
	}

	// Another User (even an Administrator) cannot cancel someone else's upload.
	call(admin, "DELETE", "/api/uploads/"+pending.ID, nil, 404)
	if got := countIncomplete(); got != 1 {
		t.Fatalf("other user's 404 altered multipart upload count: %d", got)
	}

	// Revoking Upload Right must NOT prevent the initiating User from cancelling their own upload.
	call(admin, "DELETE", fmt.Sprintf("/api/tree/%d/grants/%d", dir.ID, grant.ID), nil, 204)
	call(actor, "POST", "/api/uploads/"+pending.ID+"/parts", map[string]any{"numbers": []int{2}}, 404)
	call(actor, "DELETE", "/api/uploads/"+pending.ID, nil, 204)

	// Second cancel and subsequent part inspection return 404; MinIO multipart is aborted.
	call(actor, "DELETE", "/api/uploads/"+pending.ID, nil, 404)
	call(actor, "GET", "/api/uploads/"+pending.ID+"/parts", nil, 404)
	if got := countIncomplete(); got != 0 {
		t.Fatalf("expected 0 incomplete multipart uploads after cancel, got %d", got)
	}
	if got := countObjects(); got != 0 {
		t.Fatalf("expected 0 objects after cancel, got %d", got)
	}

	// Restore Upload Right and complete a single-file upload.
	decode(t, call(admin, "POST", fmt.Sprintf("/api/tree/%d/grants", dir.ID), map[string]any{
		"principalKind": "user",
		"principalId":   actorID,
		"rights":        7,
		"scope":         "subtree",
	}, 201), &grant)

	originalBytes := []byte("published content")
	var completed struct {
		ID string `json:"id"`
	}
	decode(t, call(actor, "POST", "/api/uploads", map[string]any{
		"parentId": dir.ID,
		"name":     "published.txt",
		"size":     len(originalBytes),
	}, 201), &completed)
	decode(t, call(actor, "POST", "/api/uploads/"+completed.ID+"/parts", map[string]any{"numbers": []int{1}}, 200), &urls)
	req, _ = http.NewRequest("PUT", server.URL+urls[0].URL, bytes.NewReader(originalBytes))
	req.AddCookie(actor.cookie)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("completed part status: %d", res.StatusCode)
	}
	var receipt struct {
		FileID int64 `json:"fileId"`
	}
	decode(t, call(actor, "POST", "/api/uploads/"+completed.ID+"/complete", nil, 200), &receipt)

	// Cancelling an already completed upload returns 409 without altering the published file.
	call(actor, "DELETE", "/api/uploads/"+completed.ID, nil, 409)
	req, _ = http.NewRequest("GET", server.URL+fmt.Sprintf("/api/tree/%d/download", receipt.FileID), nil)
	req.AddCookie(actor.cookie)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	gotBody, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !bytes.Equal(gotBody, originalBytes) {
		t.Fatalf("published file altered after 409 cancel: status=%d body=%q", res.StatusCode, gotBody)
	}

	// Cancelling a session stuck in state='completing' (e.g. name conflict) succeeds with 204 and cleans MinIO.
	var conflictUpload struct {
		ID string `json:"id"`
	}
	decode(t, call(actor, "POST", "/api/uploads", map[string]any{
		"parentId": dir.ID,
		"name":     "published.txt",
		"size":     len("replacement"),
	}, 201), &conflictUpload)
	decode(t, call(actor, "POST", "/api/uploads/"+conflictUpload.ID+"/parts", map[string]any{"numbers": []int{1}}, 200), &urls)
	req, _ = http.NewRequest("PUT", server.URL+urls[0].URL, bytes.NewReader([]byte("replacement")))
	req.AddCookie(actor.cookie)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("conflict part status: %d", res.StatusCode)
	}
	call(actor, "POST", "/api/uploads/"+conflictUpload.ID+"/complete", nil, 409)
	call(actor, "DELETE", "/api/uploads/"+conflictUpload.ID, nil, 204)
	if got := countIncomplete(); got != 0 {
		t.Fatalf("expected 0 incomplete multipart uploads after conflict cancel, got %d", got)
	}
	if got := countObjects(); got != 1 {
		t.Fatalf("expected exactly 1 published object after conflict cancel, got %d", got)
	}
}

func TestCancelUploadBatchRollsBackHiddenTreeAndMinIOObjects(t *testing.T) {
	stores := startStores(t)
	ctx := context.Background()
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
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

	conn, err := pgx.Connect(ctx, stores.config.MigrationDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	var actorID int64
	err = conn.QueryRow(ctx, `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT 'batch-user','Batch User',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`).Scan(&actorID)
	if err != nil {
		t.Fatal(err)
	}
	actor := newBrowser(t, server)
	if status, _ := actor.signIn("batch-user", initialAdministratorPassword); status != 200 {
		t.Fatalf("sign in actor: %d", status)
	}

	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/api/tree", map[string]any{"name": "CancelBatch"}, 201), &dir)
	var grant struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", fmt.Sprintf("/api/tree/%d/grants", dir.ID), map[string]any{
		"principalKind": "user",
		"principalId":   actorID,
		"rights":        7,
		"scope":         "subtree",
	}, 201), &grant)

	client, err := minio.New(stores.config.MinIOEndpoint, &minio.Options{
		Creds: credentials.NewStaticV4(stores.config.MinIOAccessKey, stores.config.MinIOSecretKey, ""),
	})
	if err != nil {
		t.Fatal(err)
	}

	countIncomplete := func() int {
		t.Helper()
		n := 0
		for u := range client.ListIncompleteUploads(ctx, stores.config.MinIOBucket, "", true) {
			if u.Err != nil {
				t.Fatal(u.Err)
			}
			n++
		}
		return n
	}
	countObjects := func() int {
		t.Helper()
		n := 0
		for o := range client.ListObjects(ctx, stores.config.MinIOBucket, minio.ListObjectsOptions{}) {
			if o.Err != nil {
				t.Fatal(o.Err)
			}
			n++
		}
		return n
	}
	putPart := func(b *browser, url string, payload []byte) {
		t.Helper()
		req, _ := http.NewRequest("PUT", server.URL+url, bytes.NewReader(payload))
		req.AddCookie(b.cookie)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("PUT %s: got %d", url, res.StatusCode)
		}
	}

	// Unknown batch returns 404.
	call(actor, "DELETE", "/api/upload-batches/does-not-exist", nil, 404)

	largeBytes := bytes.Repeat([]byte("batchdat"), 1024*1024+16) // 2 parts
	type batchSession struct {
		ID        string  `json:"id"`
		PartSize  int64   `json:"partSize"`
		PartCount int     `json:"partCount"`
		BatchID   *string `json:"batchId"`
	}
	var sessions []batchSession
	decode(t, call(actor, "POST", "/api/upload-batches", map[string]any{
		"parentId":    dir.ID,
		"name":        "Project",
		"directories": []string{"empty/leaf"},
		"files": []any{
			map[string]any{"path": "a.txt", "size": 5},
			map[string]any{"path": "nested/b.bin", "size": len(largeBytes)},
			map[string]any{"path": "deep/sub/c.txt", "size": 4},
		},
	}, 201), &sessions)
	if len(sessions) != 3 {
		t.Fatalf("expected 3 batch sessions, got %d", len(sessions))
	}
	if sessions[0].BatchID == nil || *sessions[0].BatchID == "" {
		t.Fatalf("POST /upload-batches did not return batchId: %+v", sessions)
	}
	batchID := *sessions[0].BatchID
	for i, s := range sessions {
		if s.BatchID == nil || *s.BatchID != batchID {
			t.Fatalf("session %d batchId mismatch: got %v want %q", i, s.BatchID, batchID)
		}
	}

	// Complete first child file (creates hidden file node + File Version + completed MinIO object).
	var urls []struct {
		Number int    `json:"number"`
		URL    string `json:"url"`
	}
	decode(t, call(actor, "POST", "/api/uploads/"+sessions[0].ID+"/parts", map[string]any{"numbers": []int{1}}, 200), &urls)
	putPart(actor, urls[0].URL, []byte("hello"))
	call(actor, "POST", "/api/uploads/"+sessions[0].ID+"/complete", nil, 200)

	// Upload only part 1 of second child file, leave third child untouched.
	decode(t, call(actor, "POST", "/api/uploads/"+sessions[1].ID+"/parts", map[string]any{"numbers": []int{1}}, 200), &urls)
	putPart(actor, urls[0].URL, largeBytes[:sessions[1].PartSize])

	if data := call(actor, "GET", fmt.Sprintf("/api/tree?parentId=%d", dir.ID), nil, 200); strings.Contains(string(data), "Project") {
		t.Fatalf("unrevealed batch leaked into tree listing: %s", data)
	}
	if got := countObjects(); got != 1 {
		t.Fatalf("expected 1 hidden completed object before cancel, got %d", got)
	}
	if got := countIncomplete(); got != 2 {
		t.Fatalf("expected 2 incomplete multipart uploads before cancel, got %d", got)
	}

	// Batch child sessions cannot be cancelled individually via DELETE /uploads/{id}.
	call(actor, "DELETE", "/api/uploads/"+sessions[0].ID, nil, 409)
	call(actor, "DELETE", "/api/uploads/"+sessions[1].ID, nil, 409)

	// Another User (Administrator) gets 404 on someone else's batch.
	call(admin, "DELETE", "/api/upload-batches/"+batchID, nil, 404)
	if got := countObjects(); got != 1 {
		t.Fatalf("other user's 404 removed objects: %d", got)
	}
	if got := countIncomplete(); got != 2 {
		t.Fatalf("other user's 404 removed incomplete uploads: %d", got)
	}

	// Owner can cancel their unrevealed batch even after Upload Right is revoked.
	call(admin, "DELETE", fmt.Sprintf("/api/tree/%d/grants/%d", dir.ID, grant.ID), nil, 204)
	call(actor, "DELETE", "/api/upload-batches/"+batchID, nil, 204)

	// Repeat cancel and child session lookups return 404; MinIO is completely clean.
	call(actor, "DELETE", "/api/upload-batches/"+batchID, nil, 404)
	for _, s := range sessions {
		call(actor, "GET", "/api/uploads/"+s.ID+"/parts", nil, 404)
	}
	if got := countIncomplete(); got != 0 {
		t.Fatalf("expected 0 incomplete multipart uploads after batch cancel, got %d", got)
	}
	if got := countObjects(); got != 0 {
		t.Fatalf("expected 0 MinIO objects after batch cancel, got %d", got)
	}

	// Restore Upload Right: folder name "Project" is no longer reserved and can be uploaded and revealed.
	decode(t, call(admin, "POST", fmt.Sprintf("/api/tree/%d/grants", dir.ID), map[string]any{
		"principalKind": "user",
		"principalId":   actorID,
		"rights":        7,
		"scope":         "subtree",
	}, 201), &grant)

	if data := call(actor, "GET", fmt.Sprintf("/api/tree?parentId=%d", dir.ID), nil, 200); strings.Contains(string(data), "Project") {
		t.Fatalf("cancelled batch root still visible: %s", data)
	}

	var revealedSessions []batchSession
	decode(t, call(actor, "POST", "/api/upload-batches", map[string]any{
		"parentId": dir.ID,
		"name":     "Project",
		"files": []any{
			map[string]any{"path": "final.txt", "size": 9},
		},
	}, 201), &revealedSessions)
	revealedBatchID := *revealedSessions[0].BatchID
	decode(t, call(actor, "POST", "/api/uploads/"+revealedSessions[0].ID+"/parts", map[string]any{"numbers": []int{1}}, 200), &urls)
	putPart(actor, urls[0].URL, []byte("published"))
	var receipt struct {
		FileID int64 `json:"fileId"`
	}
	decode(t, call(actor, "POST", "/api/uploads/"+revealedSessions[0].ID+"/complete", nil, 200), &receipt)

	// Already revealed batch returns 409 for owner and 404 for other Users, without altering published files.
	call(actor, "DELETE", "/api/upload-batches/"+revealedBatchID, nil, 409)
	call(admin, "DELETE", "/api/upload-batches/"+revealedBatchID, nil, 404)

	if data := call(actor, "GET", fmt.Sprintf("/api/tree?parentId=%d", dir.ID), nil, 200); !strings.Contains(string(data), "Project") {
		t.Fatalf("revealed batch missing after 409 cancel: %s", data)
	}
	req, _ := http.NewRequest("GET", server.URL+fmt.Sprintf("/api/tree/%d/download", receipt.FileID), nil)
	req.AddCookie(actor.cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	gotBody, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || string(gotBody) != "published" {
		t.Fatalf("published batch file altered after 409 cancel: status=%d body=%q", res.StatusCode, gotBody)
	}
	if got := countObjects(); got != 1 {
		t.Fatalf("expected 1 published object to remain, got %d", got)
	}
}

func TestCancelUploadEdgeCasesRecycledParentAndConcurrentComplete(t *testing.T) {
	stores := startStores(t)
	ctx := context.Background()
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
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

	client, err := minio.New(stores.config.MinIOEndpoint, &minio.Options{
		Creds: credentials.NewStaticV4(stores.config.MinIOAccessKey, stores.config.MinIOSecretKey, ""),
	})
	if err != nil {
		t.Fatal(err)
	}
	countIncomplete := func() int {
		t.Helper()
		n := 0
		for u := range client.ListIncompleteUploads(ctx, stores.config.MinIOBucket, "", true) {
			if u.Err != nil {
				t.Fatal(u.Err)
			}
			n++
		}
		return n
	}
	countObjects := func() int {
		t.Helper()
		n := 0
		for o := range client.ListObjects(ctx, stores.config.MinIOBucket, minio.ListObjectsOptions{}) {
			if o.Err != nil {
				t.Fatal(o.Err)
			}
			n++
		}
		return n
	}
	putPart := func(b *browser, url string, payload []byte) {
		t.Helper()
		req, _ := http.NewRequest("PUT", server.URL+url, bytes.NewReader(payload))
		req.AddCookie(b.cookie)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("PUT %s: got %d", url, res.StatusCode)
		}
	}

	// 1. Parent directory moved to Recycle Bin: owner can still cancel both single upload and batch.
	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/api/tree", map[string]any{"name": "RecycledParent"}, 201), &dir)
	var single struct {
		ID string `json:"id"`
	}
	decode(t, call(admin, "POST", "/api/uploads", map[string]any{"parentId": dir.ID, "name": "s.txt", "size": 3}, 201), &single)
	var batch []struct {
		ID      string  `json:"id"`
		BatchID *string `json:"batchId"`
	}
	decode(t, call(admin, "POST", "/api/upload-batches", map[string]any{
		"parentId": dir.ID,
		"name":     "HiddenDir",
		"files":    []any{map[string]any{"path": "f.txt", "size": 3}},
	}, 201), &batch)

	call(admin, "DELETE", fmt.Sprintf("/api/tree/%d", dir.ID), nil, 204)
	call(admin, "DELETE", "/api/uploads/"+single.ID, nil, 204)
	call(admin, "DELETE", "/api/upload-batches/"+*batch[0].BatchID, nil, 204)
	if got := countIncomplete(); got != 0 {
		t.Fatalf("expected 0 incomplete uploads after cancelling under recycled parent, got %d", got)
	}
	if data := call(admin, "GET", "/api/recycle-bin", nil, 200); !strings.Contains(string(data), "RecycledParent") {
		t.Fatalf("recycled parent disappeared: %s", data)
	}

	// 2. Concurrent CompleteUpload vs CancelUpload serializes cleanly without deadlock or 500.
	decode(t, call(admin, "POST", "/api/tree", map[string]any{"name": "RaceDir"}, 201), &dir)
	var raceUpload struct {
		ID string `json:"id"`
	}
	decode(t, call(admin, "POST", "/api/uploads", map[string]any{"parentId": dir.ID, "name": "race.txt", "size": 4}, 201), &raceUpload)
	var urls []struct {
		URL string `json:"url"`
	}
	decode(t, call(admin, "POST", "/api/uploads/"+raceUpload.ID+"/parts", map[string]any{"numbers": []int{1}}, 200), &urls)
	putPart(admin, urls[0].URL, []byte("race"))

	var completeStatus, cancelStatus int
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		completeStatus, _ = admin.do("POST", "/api/uploads/"+raceUpload.ID+"/complete", nil)
	}()
	go func() {
		defer wg.Done()
		cancelStatus, _ = admin.do("DELETE", "/api/uploads/"+raceUpload.ID, nil)
	}()
	wg.Wait()

	switch {
	case completeStatus == 200 && cancelStatus == 409:
		if got := countObjects(); got != 1 {
			t.Fatalf("complete won race but object count is %d", got)
		}
	case completeStatus == 404 && cancelStatus == 204:
		if got := countObjects(); got != 0 {
			t.Fatalf("cancel won race but object count is %d", got)
		}
		if got := countIncomplete(); got != 0 {
			t.Fatalf("cancel won race but incomplete count is %d", got)
		}
	default:
		t.Fatalf("unexpected concurrent outcome: complete=%d cancel=%d", completeStatus, cancelStatus)
	}
}
