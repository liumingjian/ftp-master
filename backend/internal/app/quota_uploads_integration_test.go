//go:build integration

package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/liumingjian/ftp-master/backend/internal/scheduler"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type apiQuotaExceeded struct {
	Code             string  `json:"code"`
	Message          string  `json:"message"`
	Scope            string  `json:"scope"`
	RequiredBytes    int64   `json:"requiredBytes"`
	AvailableBytes   int64   `json:"availableBytes"`
	OrganizationName *string `json:"organizationName"`
}

func newMinIOClient(t *testing.T, st stores) *minio.Client {
	t.Helper()
	client, err := minio.New(st.config.MinIOEndpoint, &minio.Options{
		Creds: credentials.NewStaticV4(st.config.MinIOAccessKey, st.config.MinIOSecretKey, ""),
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func countIncompleteUploads(t *testing.T, client *minio.Client, bucket string) int {
	t.Helper()
	n := 0
	for u := range client.ListIncompleteUploads(context.Background(), bucket, "", true) {
		if u.Err != nil {
			t.Fatal(u.Err)
		}
		n++
	}
	return n
}

func putUploadPart(t *testing.T, serverURL string, b *browser, url string, payload []byte) {
	t.Helper()
	req, err := http.NewRequest("PUT", serverURL+url, bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(b.cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	_, _ = io.ReadAll(res.Body)
	if res.StatusCode != 200 {
		t.Fatalf("PUT %s: status=%d", url, res.StatusCode)
	}
}

func completeSingleUpload(t *testing.T, serverURL string, b *browser, parentID int64, name string, payload []byte, collision string) (int64, int64) {
	t.Helper()
	status, data := b.do("POST", "/api/uploads", map[string]any{
		"parentId": parentID,
		"name":     name,
		"size":     len(payload),
	})
	if status != 201 {
		t.Fatalf("POST /api/uploads %s: status=%d: %s", name, status, data)
	}
	var session struct {
		ID        string `json:"id"`
		PartSize  int64  `json:"partSize"`
		PartCount int    `json:"partCount"`
	}
	decode(t, data, &session)
	for n := 1; n <= session.PartCount; n++ {
		status, data = b.do("POST", "/api/uploads/"+session.ID+"/parts", map[string]any{"numbers": []int{n}})
		if status != 200 {
			t.Fatalf("POST parts: status=%d: %s", status, data)
		}
		var urls []struct {
			URL string `json:"url"`
		}
		decode(t, data, &urls)
		start := int64(n-1) * session.PartSize
		end := start + session.PartSize
		if end > int64(len(payload)) {
			end = int64(len(payload))
		}
		putUploadPart(t, serverURL, b, urls[0].URL, payload[start:end])
	}
	completePath := "/api/uploads/" + session.ID + "/complete"
	if collision != "" {
		completePath += "?collision=" + collision
	}
	status, data = b.do("POST", completePath, nil)
	if status != 200 {
		t.Fatalf("POST %s: status=%d: %s", completePath, status, data)
	}
	var receipt struct {
		FileID    int64 `json:"fileId"`
		VersionID int64 `json:"versionId"`
	}
	decode(t, data, &receipt)
	return receipt.FileID, receipt.VersionID
}

func TestSingleFileUploadQuotaEnforcementPoolsCeilingsAdminAndDowngrade(t *testing.T) {
	stores := startStores(t)
	clk := clock.NewFake(time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC))
	server := startService(t, stores.config, clk)
	admin := newBrowser(t, server)
	signInAsAdministrator(t, admin)
	minioClient := newMinIOClient(t, stores)

	call := func(b *browser, method, path string, body any, want int) []byte {
		t.Helper()
		status, data := b.do(method, "/api"+path, body)
		if status != want {
			t.Fatalf("%s %s: status=%d, want %d: %s", method, path, status, want, data)
		}
		return data
	}

	// Build Organization hierarchy:
	//   GrandParent (10000 B)
	//     ├─ ChildCapped (4000 B)
	//     │    ├─ capped-child (User Quota 3000 B)
	//     │    └─ uncapped-child (no User Quota -> pool = 4000 - 3000 = 1000 B)
	//     ├─ UncappedMid (no Org Quota)
	//     │    ├─ capped-peer (User Quota 4000 B)
	//     │    └─ uncapped-peer (no User Quota -> GrandParent pool = 10000 - 4000 - 4000 = 2000 B)
	//     └─ OverQuotaBranch (no Org Quota)
	//          └─ heavy-user (will upload 8500 B while uncapped/large, then get lowered)
	var grand, childCapped, uncappedMid, overBranch apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "GrandParent", "quotaBytes": 10000}, 201), &grand)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "ChildCapped", "parentId": grand.ID, "quotaBytes": 4000}, 201), &childCapped)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "UncappedMid", "parentId": grand.ID}, 201), &uncappedMid)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "OverQuotaBranch", "parentId": grand.ID}, 201), &overBranch)

	csvBody := fmt.Sprintf(
		"username,display_name,password,organization_id\n"+
			"capped-child,Capped Child,Pass12345!,%d\n"+
			"uncapped-child,Uncapped Child,Pass12345!,%d\n"+
			"capped-peer,Capped Peer,Pass12345!,%d\n"+
			"uncapped-peer,Uncapped Peer,Pass12345!,%d\n"+
			"heavy-user,Heavy User,Pass12345!,%d\n",
		childCapped.ID, childCapped.ID, uncappedMid.ID, uncappedMid.ID, overBranch.ID,
	)
	call(admin, "POST", "/users/import", map[string]any{"csv": csvBody}, 201)

	var managed []apiManagedUserQuota
	decode(t, call(admin, "GET", "/managed-users", nil, 200), &managed)
	users := map[string]apiManagedUserQuota{}
	for _, u := range managed {
		users[u.Username] = u
	}

	// Set capped User Quotas: capped-child = 3000, capped-peer = 4000.
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", users["capped-child"].ID), map[string]any{"quotaBytes": 3000}, 200)
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", users["capped-peer"].ID), map[string]any{"quotaBytes": 4000}, 200)

	// Shared directory granting full rights to GrandParent org.
	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/tree", map[string]any{"name": "QuotaUploads"}, 201), &dir)
	call(admin, "POST", fmt.Sprintf("/tree/%d/grants", dir.ID), map[string]any{
		"principalKind": "organization",
		"principalId":   grand.ID,
		"rights":        63,
		"scope":         "subtree",
	}, 201)

	signInUser := func(username string) *browser {
		t.Helper()
		b := newBrowser(t, server)
		if status, _ := b.signIn(username, "Pass12345!"); status != 200 {
			t.Fatalf("sign in %s: %d", username, status)
		}
		return b
	}
	cappedChild := signInUser("capped-child")
	uncappedChild := signInUser("uncapped-child")
	uncappedPeer := signInUser("uncapped-peer")
	heavy := signInUser("heavy-user")

	// 1. User Quota reservation & immediate 507 refusal before MinIO multipart creation.
	var up1 struct {
		ID string `json:"id"`
	}
	decode(t, call(cappedChild, "POST", "/uploads", map[string]any{
		"parentId": dir.ID,
		"name":     "first.bin",
		"size":     2000,
	}, 201), &up1)
	if got := countIncompleteUploads(t, minioClient, stores.config.MinIOBucket); got != 1 {
		t.Fatalf("expected 1 active multipart upload, got %d", got)
	}

	// Second upload for 1001 B exceeds remaining 1000 B of User Quota -> 507, NO orphan multipart!
	var denied apiQuotaExceeded
	decode(t, call(cappedChild, "POST", "/uploads", map[string]any{
		"parentId": dir.ID,
		"name":     "too-big.bin",
		"size":     1001,
	}, 507), &denied)
	if denied.Code != "quota_exceeded" || denied.Scope != "user" || denied.RequiredBytes != 1001 || denied.AvailableBytes != 1000 || denied.OrganizationName != nil {
		t.Fatalf("unexpected user quota 507 payload: %+v", denied)
	}
	if !strings.Contains(denied.Message, "个人存储配额") || !strings.Contains(denied.Message, "1000 B") {
		t.Fatalf("unexpected Chinese user quota message: %q", denied.Message)
	}
	if got := countIncompleteUploads(t, minioClient, stores.config.MinIOBucket); got != 1 {
		t.Fatalf("507 created orphan MinIO multipart upload: got %d want 1", got)
	}

	// 2. Completing an already-reserved upload honors initial reservation even after quota downgrade!
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", users["capped-child"].ID), map[string]any{"quotaBytes": 500}, 200)
	var urls []struct {
		URL string `json:"url"`
	}
	decode(t, call(cappedChild, "POST", "/uploads/"+up1.ID+"/parts", map[string]any{"numbers": []int{1}}, 200), &urls)
	putUploadPart(t, server.URL, cappedChild, urls[0].URL, bytes.Repeat([]byte("a"), 2000))
	call(cappedChild, "POST", "/uploads/"+up1.ID+"/complete", nil, 200)

	// After completion, capped-child is over quota (2000 / 500) -> 1 B upload refused with 0 B available.
	decode(t, call(cappedChild, "POST", "/uploads", map[string]any{
		"parentId": dir.ID,
		"name":     "one-byte.bin",
		"size":     1,
	}, 507), &denied)
	if denied.Scope != "user" || denied.AvailableBytes != 0 {
		t.Fatalf("over-quota capped-child 507 = %+v", denied)
	}
	// Restore capped-child quota to 3000 so ChildCapped unallocated pool is 1000 B again.
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", users["capped-child"].ID), map[string]any{"quotaBytes": 3000}, 200)

	// 3. Isolated unallocated pool:
	//    ChildCapped has quota 4000, capped-child allocated 3000 (used 2000) -> pool = 1000 B.
	//    Physical headroom of ChildCapped is 2000 B, yet uncapped-child MUST be limited to 1000 B!
	decode(t, call(uncappedChild, "POST", "/uploads", map[string]any{
		"parentId": dir.ID,
		"name":     "invade-pool.bin",
		"size":     1001,
	}, 507), &denied)
	if denied.Code != "quota_exceeded" || denied.Scope != "organization_pool" || denied.AvailableBytes != 1000 || denied.OrganizationName == nil || *denied.OrganizationName != "ChildCapped" {
		t.Fatalf("uncapped-child pool 507 = %+v", denied)
	}
	if !strings.Contains(denied.Message, "ChildCapped") || !strings.Contains(denied.Message, "未分配配额池") {
		t.Fatalf("unexpected Chinese pool message: %q", denied.Message)
	}
	// Exact fit 1000 B succeeds!
	completeSingleUpload(t, server.URL, uncappedChild, dir.ID, "pool-exact.bin", bytes.Repeat([]byte("p"), 1000), "")

	// Also check GrandParent unallocated pool through UncappedMid:
	//   GrandParent (10000) - ChildCapped (4000) - capped-peer (4000) = 2000 B pool.
	//   uncapped-peer trying 2001 B is refused by GrandParent pool even though GrandParent physical used is only 3000!
	decode(t, call(uncappedPeer, "POST", "/uploads", map[string]any{
		"parentId": dir.ID,
		"name":     "grand-pool.bin",
		"size":     2001,
	}, 507), &denied)
	if denied.Scope != "organization_pool" || denied.AvailableBytes != 2000 || denied.OrganizationName == nil || *denied.OrganizationName != "GrandParent" {
		t.Fatalf("uncapped-peer GrandParent pool 507 = %+v", denied)
	}

	// 4. Multi-ancestor hard physical ceiling:
	//    Currently GrandParent physical used = 2000 (capped-child) + 1000 (uncapped-child) = 3000.
	//    Raise GrandParent temporarily to 20000 so heavy-user can upload 6500 B, then lower GrandParent back to 10000!
	//    Now GrandParent physical used = 9500 -> GrandParent physical headroom = 500 B.
	//    capped-child has 1000 B personal headroom & 1000 B ChildCapped headroom,
	//    but GrandParent physical ceiling MUST cap capped-child at 500 B!
	call(admin, "PATCH", fmt.Sprintf("/organizations/%d", grand.ID), map[string]any{"name": "GrandParent", "quotaBytes": 20000}, 200)
	completeSingleUpload(t, server.URL, heavy, dir.ID, "heavy.bin", bytes.Repeat([]byte("h"), 6500), "")
	call(admin, "PATCH", fmt.Sprintf("/organizations/%d", grand.ID), map[string]any{"name": "GrandParent", "quotaBytes": 10000}, 200)

	decode(t, call(cappedChild, "POST", "/uploads", map[string]any{
		"parentId": dir.ID,
		"name":     "ancestor-ceiling.bin",
		"size":     501,
	}, 507), &denied)
	if denied.Code != "quota_exceeded" || denied.Scope != "organization_total" || denied.AvailableBytes != 500 || denied.OrganizationName == nil || *denied.OrganizationName != "GrandParent" {
		t.Fatalf("multi-ancestor physical ceiling 507 = %+v", denied)
	}
	if !strings.Contains(denied.Message, "GrandParent") || !strings.Contains(denied.Message, "总存储配额") {
		t.Fatalf("unexpected Chinese ancestor total message: %q", denied.Message)
	}
	// Exact 500 B fits GrandParent physical ceiling!
	completeSingleUpload(t, server.URL, cappedChild, dir.ID, "ancestor-exact.bin", bytes.Repeat([]byte("e"), 500), "")

	// 5. Administrators are enforced uniformly.
	adminUser := users[initialAdministratorUsername]
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", adminUser.ID), map[string]any{"quotaBytes": 100}, 200)
	decode(t, call(admin, "POST", "/uploads", map[string]any{
		"parentId": dir.ID,
		"name":     "admin-too-big.bin",
		"size":     101,
	}, 507), &denied)
	if denied.Scope != "user" || denied.AvailableBytes != 100 {
		t.Fatalf("admin quota 507 = %+v", denied)
	}
	// Clear admin quota back to unlimited.
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", adminUser.ID), map[string]any{"quotaBytes": nil}, 200)

	// 6. Refused upload initiations record failed upload Audit Events with structured details.
	var auditResp struct {
		Total  int `json:"total"`
		Events []struct {
			Action   string         `json:"action"`
			Outcome  string         `json:"outcome"`
			Username string         `json:"username"`
			Path     string         `json:"path"`
			Detail   map[string]any `json:"detail"`
		} `json:"events"`
	}
	decode(t, call(admin, "POST", "/audit/query", map[string]any{
		"from":         "2026-11-25T00:00:00Z",
		"to":           "2026-11-26T00:00:00Z",
		"action":       "upload",
		"failuresOnly": true,
	}, 200), &auditResp)
	if auditResp.Total != 6 {
		raw, _ := json.Marshal(auditResp)
		t.Fatalf("failed upload audit total = %d, want 6: %s", auditResp.Total, raw)
	}
	foundScopes := map[string]bool{}
	for _, ev := range auditResp.Events {
		if ev.Outcome != "failure" || ev.Detail["reason"] != "quota_exceeded" {
			t.Fatalf("unexpected failed upload audit event: %+v", ev)
		}
		if scope, ok := ev.Detail["scope"].(string); ok {
			foundScopes[scope] = true
		}
		if _, ok := ev.Detail["requiredBytes"].(float64); !ok {
			t.Fatalf("missing requiredBytes in audit detail: %+v", ev)
		}
		if _, ok := ev.Detail["availableBytes"].(float64); !ok {
			t.Fatalf("missing availableBytes in audit detail: %+v", ev)
		}
	}
	for _, wantScope := range []string{"user", "organization_pool", "organization_total"} {
		if !foundScopes[wantScope] {
			t.Fatalf("missing audit scope %q in %+v", wantScope, foundScopes)
		}
	}
}

func TestFolderBatchUploadQuotaReservationAtomicRefusalAndZeroByteBatch(t *testing.T) {
	stores := startStores(t)
	clk := clock.NewFake(time.Date(2026, 11, 25, 13, 0, 0, 0, time.UTC))
	server := startService(t, stores.config, clk)
	admin := newBrowser(t, server)
	signInAsAdministrator(t, admin)
	minioClient := newMinIOClient(t, stores)

	call := func(b *browser, method, path string, body any, want int) []byte {
		t.Helper()
		status, data := b.do(method, "/api"+path, body)
		if status != want {
			t.Fatalf("%s %s: status=%d, want %d: %s", method, path, status, want, data)
		}
		return data
	}

	var org apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "BatchOrg", "quotaBytes": 10000}, 201), &org)
	csvBody := fmt.Sprintf("username,display_name,password,organization_id\nbatch-alice,Batch Alice,Pass12345!,%d\n", org.ID)
	call(admin, "POST", "/users/import", map[string]any{"csv": csvBody}, 201)

	var managed []apiManagedUserQuota
	decode(t, call(admin, "GET", "/managed-users", nil, 200), &managed)
	var aliceID int64
	for _, u := range managed {
		if u.Username == "batch-alice" {
			aliceID = u.ID
		}
	}
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", aliceID), map[string]any{"quotaBytes": 3000}, 200)

	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/tree", map[string]any{"name": "BatchQuota"}, 201), &dir)
	call(admin, "POST", fmt.Sprintf("/tree/%d/grants", dir.ID), map[string]any{
		"principalKind": "user",
		"principalId":   aliceID,
		"rights":        63,
		"scope":         "subtree",
	}, 201)

	alice := newBrowser(t, server)
	if status, _ := alice.signIn("batch-alice", "Pass12345!"); status != 200 {
		t.Fatalf("alice sign in: %d", status)
	}

	readAlice := func() apiManagedUserQuota {
		t.Helper()
		var list []apiManagedUserQuota
		decode(t, call(admin, "GET", "/managed-users", nil, 200), &list)
		for _, u := range list {
			if u.ID == aliceID {
				return u
			}
		}
		t.Fatalf("alice not found")
		return apiManagedUserQuota{}
	}

	// 1. Over-quota folder batch (1500 + 1501 = 3001 > 3000) is refused atomically with 507
	//    BEFORE creating hidden directories, batches, or MinIO multipart uploads.
	var denied apiQuotaExceeded
	decode(t, call(alice, "POST", "/upload-batches", map[string]any{
		"parentId":    dir.ID,
		"name":        "ProjectA",
		"directories": []string{"empty"},
		"files": []any{
			map[string]any{"path": "a.txt", "size": 1500},
			map[string]any{"path": "nested/b.txt", "size": 1501},
		},
	}, 507), &denied)
	if denied.Code != "quota_exceeded" || denied.Scope != "user" || denied.RequiredBytes != 3001 || denied.AvailableBytes != 3000 {
		t.Fatalf("batch 507 = %+v", denied)
	}
	if !strings.Contains(denied.Message, "个人存储配额") {
		t.Fatalf("batch 507 message = %q", denied.Message)
	}
	if got := countIncompleteUploads(t, minioClient, stores.config.MinIOBucket); got != 0 {
		t.Fatalf("507 batch created orphan MinIO multipart uploads: got %d want 0", got)
	}
	if u := readAlice(); u.ReservedBytes != 0 || u.CommittedBytes != 0 {
		t.Fatalf("507 batch leaked usage: %+v", u)
	}

	// 2. Reusing the exact same folder name "ProjectA" with 2500 B succeeds (proving no hidden root was left behind!).
	var sessions []struct {
		ID      string  `json:"id"`
		BatchID *string `json:"batchId"`
	}
	decode(t, call(alice, "POST", "/upload-batches", map[string]any{
		"parentId": dir.ID,
		"name":     "ProjectA",
		"files": []any{
			map[string]any{"path": "a.txt", "size": 1000},
			map[string]any{"path": "nested/b.txt", "size": 1500},
		},
	}, 201), &sessions)
	if len(sessions) != 2 || sessions[0].BatchID == nil {
		t.Fatalf("unexpected sessions: %+v", sessions)
	}
	if u := readAlice(); u.ReservedBytes != 2500 || u.CommittedBytes != 0 || u.UsedBytes != 2500 {
		t.Fatalf("after batch init usage = %+v, want reserved=2500", u)
	}

	// Concurrent single-file upload exceeding remaining 500 B is refused with 507.
	decode(t, call(alice, "POST", "/uploads", map[string]any{
		"parentId": dir.ID,
		"name":     "extra.bin",
		"size":     501,
	}, 507), &denied)
	if denied.AvailableBytes != 500 {
		t.Fatalf("after batch reservation availableBytes = %d, want 500", denied.AvailableBytes)
	}

	// 3. Complete first child (1000 B): swaps reserved -> committed with ZERO double-counting.
	var urls []struct {
		URL string `json:"url"`
	}
	decode(t, call(alice, "POST", "/uploads/"+sessions[0].ID+"/parts", map[string]any{"numbers": []int{1}}, 200), &urls)
	putUploadPart(t, server.URL, alice, urls[0].URL, bytes.Repeat([]byte("a"), 1000))
	call(alice, "POST", "/uploads/"+sessions[0].ID+"/complete", nil, 200)
	if u := readAlice(); u.CommittedBytes != 1000 || u.ReservedBytes != 1500 || u.UsedBytes != 2500 {
		t.Fatalf("mid-batch usage = %+v, want committed=1000 reserved=1500 used=2500", u)
	}

	// 4. Lower alice's quota to 100 B mid-batch: completing the second reserved child MUST still succeed and reveal ProjectA!
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", aliceID), map[string]any{"quotaBytes": 100}, 200)
	decode(t, call(alice, "POST", "/uploads/"+sessions[1].ID+"/parts", map[string]any{"numbers": []int{1}}, 200), &urls)
	putUploadPart(t, server.URL, alice, urls[0].URL, bytes.Repeat([]byte("b"), 1500))
	call(alice, "POST", "/uploads/"+sessions[1].ID+"/complete", nil, 200)
	if u := readAlice(); u.CommittedBytes != 2500 || u.ReservedBytes != 0 || u.UsedBytes != 2500 {
		t.Fatalf("completed batch usage = %+v, want committed=2500 reserved=0", u)
	}
	if data := call(alice, "GET", fmt.Sprintf("/tree?parentId=%d", dir.ID), nil, 200); !strings.Contains(string(data), "ProjectA") {
		t.Fatalf("revealed ProjectA missing: %s", data)
	}

	// 5. Over-quota alice (2500 / 100) can still initiate a zero-file folder batch (empty directories).
	call(alice, "POST", "/upload-batches", map[string]any{
		"parentId":    dir.ID,
		"name":        "EmptyOnly",
		"directories": []string{"sub/leaf"},
		"files":       []any{},
	}, 201)
	if data := call(alice, "GET", fmt.Sprintf("/tree?parentId=%d", dir.ID), nil, 200); !strings.Contains(string(data), "EmptyOnly") {
		t.Fatalf("zero-file batch EmptyOnly missing: %s", data)
	}

	// 6. Verify refused batch recorded a failed upload Audit Event with path "/BatchQuota/ProjectA".
	var auditResp struct {
		Events []struct {
			Action  string         `json:"action"`
			Outcome string         `json:"outcome"`
			Path    string         `json:"path"`
			Detail  map[string]any `json:"detail"`
		} `json:"events"`
	}
	decode(t, call(admin, "POST", "/audit/query", map[string]any{
		"from":         "2026-11-25T00:00:00Z",
		"to":           "2026-11-26T00:00:00Z",
		"action":       "upload",
		"failuresOnly": true,
	}, 200), &auditResp)
	foundBatchFailure := false
	for _, ev := range auditResp.Events {
		if ev.Path == "/BatchQuota/ProjectA" && ev.Outcome == "failure" && ev.Detail["reason"] == "quota_exceeded" && int64(ev.Detail["requiredBytes"].(float64)) == 3001 && int64(ev.Detail["availableBytes"].(float64)) == 3000 {
			foundBatchFailure = true
		}
	}
	if !foundBatchFailure {
		raw, _ := json.Marshal(auditResp)
		t.Fatalf("missing failed upload audit for refused folder batch: %s", raw)
	}
}

func TestUploadCancellationAndScheduledExpiryReleaseQuota(t *testing.T) {
	stores := startStores(t)
	ctx := context.Background()
	clk := clock.NewFake(time.Date(2026, 11, 25, 14, 0, 0, 0, time.UTC))
	server := startService(t, stores.config, clk)
	admin := newBrowser(t, server)
	signInAsAdministrator(t, admin)
	minioClient := newMinIOClient(t, stores)

	pool, err := pgxpool.New(ctx, stores.config.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	job := scheduler.New(pool, minioClient, stores.config.MinIOBucket, clk)

	call := func(b *browser, method, path string, body any, want int) []byte {
		t.Helper()
		status, data := b.do(method, "/api"+path, body)
		if status != want {
			t.Fatalf("%s %s: status=%d, want %d: %s", method, path, status, want, data)
		}
		return data
	}

	var org apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "ReleaseOrg", "quotaBytes": 2000}, 201), &org)
	csvBody := fmt.Sprintf("username,display_name,password,organization_id\nrel-user,Release User,Pass12345!,%d\n", org.ID)
	call(admin, "POST", "/users/import", map[string]any{"csv": csvBody}, 201)

	var managed []apiManagedUserQuota
	decode(t, call(admin, "GET", "/managed-users", nil, 200), &managed)
	var userID int64
	for _, u := range managed {
		if u.Username == "rel-user" {
			userID = u.ID
		}
	}
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userID), map[string]any{"quotaBytes": 2000}, 200)

	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/tree", map[string]any{"name": "ReleaseDir"}, 201), &dir)
	call(admin, "POST", fmt.Sprintf("/tree/%d/grants", dir.ID), map[string]any{
		"principalKind": "user",
		"principalId":   userID,
		"rights":        63,
		"scope":         "subtree",
	}, 201)

	user := newBrowser(t, server)
	if status, _ := user.signIn("rel-user", "Pass12345!"); status != 200 {
		t.Fatalf("sign in rel-user: %d", status)
	}

	readUser := func() apiManagedUserQuota {
		t.Helper()
		var list []apiManagedUserQuota
		decode(t, call(admin, "GET", "/managed-users", nil, 200), &list)
		for _, u := range list {
			if u.ID == userID {
				return u
			}
		}
		t.Fatalf("rel-user not found")
		return apiManagedUserQuota{}
	}

	// 1. Cancel incomplete single-file upload immediately frees reserved quota.
	var single struct {
		ID string `json:"id"`
	}
	decode(t, call(user, "POST", "/uploads", map[string]any{"parentId": dir.ID, "name": "hold.bin", "size": 2000}, 201), &single)
	call(user, "POST", "/uploads", map[string]any{"parentId": dir.ID, "name": "blocked.bin", "size": 1}, 507)

	call(user, "DELETE", "/uploads/"+single.ID, nil, 204)
	if u := readUser(); u.ReservedBytes != 0 || u.UsedBytes != 0 {
		t.Fatalf("after single cancel usage = %+v, want 0", u)
	}
	// Subsequent full-quota upload immediately succeeds!
	decode(t, call(user, "POST", "/uploads", map[string]any{"parentId": dir.ID, "name": "retry.bin", "size": 2000}, 201), &single)
	call(user, "DELETE", "/uploads/"+single.ID, nil, 204)

	// 2. Cancel unrevealed folder batch (with 1 completed provisional child + 1 pending child) immediately frees BOTH provisional committed and reserved bytes.
	var batch []struct {
		ID      string  `json:"id"`
		BatchID *string `json:"batchId"`
	}
	decode(t, call(user, "POST", "/upload-batches", map[string]any{
		"parentId": dir.ID,
		"name":     "CancelBatchQuota",
		"files": []any{
			map[string]any{"path": "done.txt", "size": 800},
			map[string]any{"path": "pending.txt", "size": 1200},
		},
	}, 201), &batch)
	var urls []struct {
		URL string `json:"url"`
	}
	decode(t, call(user, "POST", "/uploads/"+batch[0].ID+"/parts", map[string]any{"numbers": []int{1}}, 200), &urls)
	putUploadPart(t, server.URL, user, urls[0].URL, bytes.Repeat([]byte("d"), 800))
	call(user, "POST", "/uploads/"+batch[0].ID+"/complete", nil, 200)
	if u := readUser(); u.CommittedBytes != 800 || u.ReservedBytes != 1200 || u.UsedBytes != 2000 {
		t.Fatalf("mid-batch usage = %+v, want committed=800 reserved=1200", u)
	}
	call(user, "POST", "/uploads", map[string]any{"parentId": dir.ID, "name": "blocked2.bin", "size": 1}, 507)

	call(user, "DELETE", "/upload-batches/"+*batch[0].BatchID, nil, 204)
	if u := readUser(); u.CommittedBytes != 0 || u.ReservedBytes != 0 || u.UsedBytes != 0 {
		t.Fatalf("after batch cancel usage = %+v, want 0", u)
	}

	// 3. 24-hour scheduled expiry releases both abandoned single-file uploads AND unrevealed folder batches (including provisional completed children).
	decode(t, call(user, "POST", "/uploads", map[string]any{"parentId": dir.ID, "name": "expire-single.bin", "size": 700}, 201), &single)
	decode(t, call(user, "POST", "/upload-batches", map[string]any{
		"parentId": dir.ID,
		"name":     "ExpireBatch",
		"files": []any{
			map[string]any{"path": "part-done.txt", "size": 500},
			map[string]any{"path": "part-pending.txt", "size": 800},
		},
	}, 201), &batch)
	decode(t, call(user, "POST", "/uploads/"+batch[0].ID+"/parts", map[string]any{"numbers": []int{1}}, 200), &urls)
	putUploadPart(t, server.URL, user, urls[0].URL, bytes.Repeat([]byte("x"), 500))
	call(user, "POST", "/uploads/"+batch[0].ID+"/complete", nil, 200)
	if u := readUser(); u.CommittedBytes != 500 || u.ReservedBytes != 1500 || u.UsedBytes != 2000 {
		t.Fatalf("before expiry usage = %+v, want committed=500 reserved=1500", u)
	}
	call(user, "POST", "/uploads", map[string]any{"parentId": dir.ID, "name": "blocked3.bin", "size": 1}, 507)

	// 23 hours: not yet expired.
	clk.Advance(23 * time.Hour)
	if err := job.Run(ctx); err != nil {
		t.Fatal(err)
	}
	signInAsAdministrator(t, admin)
	if u := readUser(); u.UsedBytes != 2000 {
		t.Fatalf("at 23h usage = %+v, want still 2000", u)
	}

	// Past 24 hours: scheduler cleans expired uploads + batches and releases all 2000 bytes!
	clk.Advance(2 * time.Hour)
	if err := job.Run(ctx); err != nil {
		t.Fatal(err)
	}
	// Re-sign-in after clock advance past 2h session TTL.
	signInAsAdministrator(t, admin)
	if status, _ := user.signIn("rel-user", "Pass12345!"); status != 200 {
		t.Fatalf("re-sign in rel-user: %d", status)
	}
	if u := readUser(); u.CommittedBytes != 0 || u.ReservedBytes != 0 || u.UsedBytes != 0 {
		t.Fatalf("after 24h expiry usage = %+v, want 0", u)
	}
	// Full 2000 B upload now succeeds!
	completeSingleUpload(t, server.URL, user, dir.ID, "after-expiry.bin", bytes.Repeat([]byte("z"), 2000), "")
}

func TestOverQuotaAllowedOpsVersionPruningAttributionShiftAndRecycleBinAccounting(t *testing.T) {
	stores := startStores(t)
	ctx := context.Background()
	clk := clock.NewFake(time.Date(2026, 11, 25, 15, 0, 0, 0, time.UTC))
	server := startService(t, stores.config, clk)
	admin := newBrowser(t, server)
	signInAsAdministrator(t, admin)
	minioClient := newMinIOClient(t, stores)

	pool, err := pgxpool.New(ctx, stores.config.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	job := scheduler.New(pool, minioClient, stores.config.MinIOBucket, clk)

	call := func(b *browser, method, path string, body any, want int) []byte {
		t.Helper()
		status, data := b.do(method, "/api"+path, body)
		if status != want {
			t.Fatalf("%s %s: status=%d, want %d: %s", method, path, status, want, data)
		}
		return data
	}

	var org apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "AccountingOrg"}, 201), &org)
	csvBody := fmt.Sprintf(
		"username,display_name,password,organization_id\n"+
			"acct-alice,Acct Alice,Pass12345!,%d\n"+
			"acct-bob,Acct Bob,Pass12345!,%d\n"+
			"acct-carol,Acct Carol,Pass12345!,%d\n",
		org.ID, org.ID, org.ID,
	)
	call(admin, "POST", "/users/import", map[string]any{"csv": csvBody}, 201)

	var managed []apiManagedUserQuota
	decode(t, call(admin, "GET", "/managed-users", nil, 200), &managed)
	uid := map[string]int64{}
	for _, u := range managed {
		uid[u.Username] = u.ID
	}

	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/tree", map[string]any{"name": "AccountingDir"}, 201), &dir)
	call(admin, "POST", fmt.Sprintf("/tree/%d/grants", dir.ID), map[string]any{
		"principalKind": "organization",
		"principalId":   org.ID,
		"rights":        63,
		"scope":         "subtree",
	}, 201)

	signInUser := func(username string) *browser {
		t.Helper()
		b := newBrowser(t, server)
		if status, _ := b.signIn(username, "Pass12345!"); status != 200 {
			t.Fatalf("sign in %s: %d", username, status)
		}
		return b
	}
	alice := signInUser("acct-alice")
	bob := signInUser("acct-bob")
	carol := signInUser("acct-carol")

	readUsers := func() map[string]apiManagedUserQuota {
		t.Helper()
		var list []apiManagedUserQuota
		decode(t, call(admin, "GET", "/managed-users", nil, 200), &list)
		m := map[string]apiManagedUserQuota{}
		for _, u := range list {
			m[u.Username] = u
		}
		return m
	}

	// --- Part 1: Over-quota allowed read & zero-byte operations ---
	v1Payload := bytes.Repeat([]byte("A"), 1000)
	fileID, v1ID := completeSingleUpload(t, server.URL, alice, dir.ID, "shared.txt", v1Payload, "")
	// Lower alice's quota below current usage (100 < 1000).
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", uid["acct-alice"]), map[string]any{"quotaBytes": 100}, 200)

	// New byte-increasing upload is blocked.
	call(alice, "POST", "/uploads", map[string]any{"parentId": dir.ID, "name": "blocked.txt", "size": 1}, 507)

	// Browse, preview, download, create empty directory, rename, move, delete, restore from Recycle Bin ALL succeed!
	call(alice, "GET", fmt.Sprintf("/tree?parentId=%d", dir.ID), nil, 200)
	call(alice, "GET", fmt.Sprintf("/tree/%d/preview", fileID), nil, 200)
	dlReq, _ := http.NewRequest("GET", server.URL+fmt.Sprintf("/api/tree/%d/download", fileID), nil)
	dlReq.AddCookie(alice.cookie)
	dlRes, err := http.DefaultClient.Do(dlReq)
	if err != nil {
		t.Fatal(err)
	}
	dlBody, _ := io.ReadAll(dlRes.Body)
	dlRes.Body.Close()
	if dlRes.StatusCode != 200 || !bytes.Equal(dlBody, v1Payload) {
		t.Fatalf("over-quota download failed: status=%d len=%d", dlRes.StatusCode, len(dlBody))
	}

	var subDir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(alice, "POST", "/tree", map[string]any{"parentId": dir.ID, "name": "EmptySub"}, 201), &subDir)
	call(alice, "POST", fmt.Sprintf("/tree/%d/rename", fileID), map[string]any{"name": "shared-renamed.txt"}, 200)
	call(alice, "POST", fmt.Sprintf("/tree/%d/move", fileID), map[string]any{"parentId": subDir.ID}, 200)
	call(alice, "DELETE", fmt.Sprintf("/tree/%d", fileID), nil, 204)
	call(alice, "POST", fmt.Sprintf("/tree/%d/restore", fileID), map[string]any{}, 204)
	call(alice, "POST", fmt.Sprintf("/tree/%d/move", fileID), map[string]any{"parentId": dir.ID}, 200)
	call(alice, "POST", fmt.Sprintf("/tree/%d/rename", fileID), map[string]any{"name": "shared.txt"}, 200)

	// --- Part 2: RestoreFileVersion adds 0 bytes; 20-version pruning shifts attribution seamlessly ---
	// Grant Bob directly on shared.txt so same-name uploads overwrite as new File Versions on fileID.
	call(admin, "POST", fmt.Sprintf("/tree/%d/grants", fileID), map[string]any{
		"principalKind": "user",
		"principalId":   uid["acct-bob"],
		"rights":        15,
		"scope":         "subtree",
	}, 201)
	// Bob creates 19 additional versions (v2..v20, 100 B each = 1900 B).
	for i := 2; i <= 20; i++ {
		gotFileID, _ := completeSingleUpload(t, server.URL, bob, dir.ID, "shared.txt", bytes.Repeat([]byte{byte('a' + i%26)}, 100), "new_version")
		if gotFileID != fileID {
			t.Fatalf("version %d wrote file %d instead of %d", i, gotFileID, fileID)
		}
	}
	us := readUsers()
	if us["acct-alice"].CommittedBytes != 1000 || us["acct-bob"].CommittedBytes != 1900 {
		t.Fatalf("before restore: alice=%d bob=%d, want 1000, 1900", us["acct-alice"].CommittedBytes, us["acct-bob"].CommittedBytes)
	}
	// Put Bob over quota (500 < 1900), then Bob restores Alice's v1 -> MUST succeed and add 0 bytes!
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", uid["acct-bob"]), map[string]any{"quotaBytes": 500}, 200)
	call(bob, "POST", fmt.Sprintf("/tree/%d/versions/%d/restore", fileID, v1ID), nil, 201)

	us = readUsers()
	if us["acct-alice"].CommittedBytes != 1000 || us["acct-bob"].CommittedBytes != 1900 {
		t.Fatalf("immediately after restore: alice=%d bob=%d, want 1000, 1900 (0 extra bytes)", us["acct-alice"].CommittedBytes, us["acct-bob"].CommittedBytes)
	}

	// Run scheduler -> 20-version pruning deletes v1 (Alice's), keeping v2..v21 (where v21 is Bob's restore of v1's object_key).
	// Attribution MUST shift seamlessly from Alice (1000 -> 0) to Bob (1900 -> 2900) without dropping or double-counting!
	if err := job.Run(ctx); err != nil {
		t.Fatal(err)
	}
	us = readUsers()
	if us["acct-alice"].CommittedBytes != 0 || us["acct-bob"].CommittedBytes != 2900 {
		t.Fatalf("after 20-version pruning: alice=%d bob=%d, want 0, 2900", us["acct-alice"].CommittedBytes, us["acct-bob"].CommittedBytes)
	}
	// Physical object is still intact and downloadable as the latest version (v21)!
	dlReq, _ = http.NewRequest("GET", server.URL+fmt.Sprintf("/api/tree/%d/download", fileID), nil)
	dlReq.AddCookie(bob.cookie)
	dlRes, err = http.DefaultClient.Do(dlReq)
	if err != nil {
		t.Fatal(err)
	}
	dlBody, _ = io.ReadAll(dlRes.Body)
	dlRes.Body.Close()
	if dlRes.StatusCode != 200 || !bytes.Equal(dlBody, v1Payload) {
		t.Fatalf("download after pruning v1 failed: status=%d len=%d", dlRes.StatusCode, len(dlBody))
	}

	// --- Part 3: Recycle Bin soft-delete keeps bytes counted; manual & 30-day scheduled purge release them ---
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", uid["acct-carol"]), map[string]any{"quotaBytes": 1500}, 200)
	cFile1, _ := completeSingleUpload(t, server.URL, carol, dir.ID, "c1.bin", bytes.Repeat([]byte("1"), 800), "")
	cFile2, _ := completeSingleUpload(t, server.URL, carol, dir.ID, "c2.bin", bytes.Repeat([]byte("2"), 700), "")
	if u := readUsers()["acct-carol"]; u.CommittedBytes != 1500 {
		t.Fatalf("carol before delete = %+v, want 1500", u)
	}
	// Soft-delete cFile1 -> still counted, 1 B upload still refused with 507!
	call(carol, "DELETE", fmt.Sprintf("/tree/%d", cFile1), nil, 204)
	if u := readUsers()["acct-carol"]; u.CommittedBytes != 1500 {
		t.Fatalf("carol after soft-delete = %+v, want still 1500", u)
	}
	call(carol, "POST", "/uploads", map[string]any{"parentId": dir.ID, "name": "blocked-bin.bin", "size": 1}, 507)

	// Manual purge cFile1 -> immediately frees 800 B so an 800 B upload succeeds!
	call(admin, "DELETE", fmt.Sprintf("/tree/%d/purge", cFile1), nil, 204)
	if u := readUsers()["acct-carol"]; u.CommittedBytes != 700 {
		t.Fatalf("carol after manual purge = %+v, want 700", u)
	}
	completeSingleUpload(t, server.URL, carol, dir.ID, "c3.bin", bytes.Repeat([]byte("3"), 800), "")
	if u := readUsers()["acct-carol"]; u.CommittedBytes != 1500 {
		t.Fatalf("carol after re-upload = %+v, want 1500", u)
	}

	// Soft-delete cFile2 -> still counted after 29 days, released on 30-day scheduled purge!
	call(carol, "DELETE", fmt.Sprintf("/tree/%d", cFile2), nil, 204)
	clk.Advance(29 * 24 * time.Hour)
	if err := job.Run(ctx); err != nil {
		t.Fatal(err)
	}
	signInAsAdministrator(t, admin)
	if u := readUsers()["acct-carol"]; u.CommittedBytes != 1500 {
		t.Fatalf("carol at 29 days = %+v, want still 1500", u)
	}
	clk.Advance(2 * 24 * time.Hour)
	if err := job.Run(ctx); err != nil {
		t.Fatal(err)
	}
	signInAsAdministrator(t, admin)
	carol = signInUser("acct-carol")
	if u := readUsers()["acct-carol"]; u.CommittedBytes != 800 {
		t.Fatalf("carol after 30-day automatic purge = %+v, want 800", u)
	}
	// Freed 700 B allows a 700 B upload!
	completeSingleUpload(t, server.URL, carol, dir.ID, "c4.bin", bytes.Repeat([]byte("4"), 700), "")
}

func TestConcurrentUploadsAndQuotaMembershipMutationsRespectLockOrder(t *testing.T) {
	stores := startStores(t)
	clk := clock.NewFake(time.Date(2026, 11, 25, 16, 0, 0, 0, time.UTC))
	server := startService(t, stores.config, clk)
	admin := newBrowser(t, server)
	signInAsAdministrator(t, admin)
	minioClient := newMinIOClient(t, stores)

	call := func(b *browser, method, path string, body any, want int) []byte {
		t.Helper()
		status, data := b.do(method, "/api"+path, body)
		if status != want {
			t.Fatalf("%s %s: status=%d, want %d: %s", method, path, status, want, data)
		}
		return data
	}

	var orgA, orgB apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "ConcOrgA", "quotaBytes": 5000}, 201), &orgA)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "ConcOrgB", "quotaBytes": 5000}, 201), &orgB)

	csvBody := fmt.Sprintf(
		"username,display_name,password,organization_id\n"+
			"conc-u1,Conc U1,Pass12345!,%d\n"+
			"conc-u2,Conc U2,Pass12345!,%d\n",
		orgA.ID, orgA.ID,
	)
	call(admin, "POST", "/users/import", map[string]any{"csv": csvBody}, 201)

	var managed []apiManagedUserQuota
	decode(t, call(admin, "GET", "/managed-users", nil, 200), &managed)
	uid := map[string]int64{}
	for _, u := range managed {
		uid[u.Username] = u.ID
	}
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", uid["conc-u1"]), map[string]any{"quotaBytes": 5000}, 200)

	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/tree", map[string]any{"name": "ConcDir"}, 201), &dir)
	for _, id := range []int64{orgA.ID, orgB.ID} {
		call(admin, "POST", fmt.Sprintf("/tree/%d/grants", dir.ID), map[string]any{
			"principalKind": "organization",
			"principalId":   id,
			"rights":        63,
			"scope":         "subtree",
		}, 201)
	}

	u1 := newBrowser(t, server)
	if status, _ := u1.signIn("conc-u1", "Pass12345!"); status != 200 {
		t.Fatalf("sign in conc-u1: %d", status)
	}
	u2 := newBrowser(t, server)
	if status, _ := u2.signIn("conc-u2", "Pass12345!"); status != 200 {
		t.Fatalf("sign in conc-u2: %d", status)
	}

	// Part A: 10 concurrent 1000 B uploads racing against a 5000 B ceiling -> EXACTLY 5 win, 5 get 507, 0 over-allocation!
	var createdCount, deniedCount atomic.Int32
	var createdIDs sync.Map
	startGate := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-startGate
			status, data := u1.do("POST", "/api/uploads", map[string]any{
				"parentId": dir.ID,
				"name":     fmt.Sprintf("race-%d.bin", i),
				"size":     1000,
			})
			switch status {
			case 201:
				var s struct {
					ID string `json:"id"`
				}
				if err := json.Unmarshal(data, &s); err != nil {
					t.Errorf("decode 201: %v", err)
					return
				}
				createdIDs.Store(i, s.ID)
				createdCount.Add(1)
			case 507:
				deniedCount.Add(1)
			default:
				t.Errorf("race upload %d unexpected status=%d: %s", i, status, data)
			}
		}()
	}
	close(startGate)
	wg.Wait()

	if createdCount.Load() != 5 || deniedCount.Load() != 5 {
		t.Fatalf("concurrent race outcomes: created=%d denied=%d, want 5 and 5", createdCount.Load(), deniedCount.Load())
	}
	if got := countIncompleteUploads(t, minioClient, stores.config.MinIOBucket); got != 5 {
		t.Fatalf("incomplete MinIO uploads = %d, want 5", got)
	}

	// Cancel all 5 sessions before Part B.
	createdIDs.Range(func(_, v any) bool {
		call(u1, "DELETE", "/uploads/"+v.(string), nil, 204)
		return true
	})

	// Part B: Simultaneous uploads, folder batches, quota edits, and user moves under strict 725005 -> 725010 ordering.
	// Must complete cleanly with zero deadlocks and zero 5xx errors!
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", uid["conc-u1"]), map[string]any{"quotaBytes": 3000}, 200)
	stressGate := make(chan struct{})
	var stressWG sync.WaitGroup

	// 1. Concurrent single-file upload initiations & cancellations by u1.
	for i := 0; i < 6; i++ {
		i := i
		stressWG.Add(1)
		go func() {
			defer stressWG.Done()
			<-stressGate
			for iter := 0; iter < 3; iter++ {
				status, data := u1.do("POST", "/api/uploads", map[string]any{
					"parentId": dir.ID,
					"name":     fmt.Sprintf("stress-%d-%d.bin", i, iter),
					"size":     600,
				})
				if status == 201 {
					var s struct {
						ID string `json:"id"`
					}
					if err := json.Unmarshal(data, &s); err == nil && s.ID != "" {
						delStatus, delData := u1.do("DELETE", "/api/uploads/"+s.ID, nil)
						if delStatus != 204 && delStatus != 404 {
							t.Errorf("stress cancel status=%d: %s", delStatus, delData)
						}
					}
				} else if status != 507 {
					t.Errorf("stress upload status=%d: %s", status, data)
				}
			}
		}()
	}

	// 2. Concurrent folder batch initiations & cancellations by u2.
	for i := 0; i < 4; i++ {
		i := i
		stressWG.Add(1)
		go func() {
			defer stressWG.Done()
			<-stressGate
			for iter := 0; iter < 3; iter++ {
				status, data := u2.do("POST", "/api/upload-batches", map[string]any{
					"parentId": dir.ID,
					"name":     fmt.Sprintf("StressBatch-%d-%d", i, iter),
					"files":    []any{map[string]any{"path": "f.txt", "size": 500}},
				})
				if status == 201 {
					var ss []struct {
						BatchID *string `json:"batchId"`
					}
					if err := json.Unmarshal(data, &ss); err == nil && len(ss) > 0 && ss[0].BatchID != nil {
						delStatus, delData := u2.do("DELETE", "/api/upload-batches/"+*ss[0].BatchID, nil)
						if delStatus != 204 && delStatus != 404 {
							t.Errorf("stress batch cancel status=%d: %s", delStatus, delData)
						}
					}
				} else if status != 507 && status != 409 {
					t.Errorf("stress batch status=%d: %s", status, data)
				}
			}
		}()
	}

	// 3. Concurrent Administrator quota edits (725005) & user moves (725005).
	stressWG.Add(2)
	go func() {
		defer stressWG.Done()
		<-stressGate
		for _, qVal := range []int64{2000, 4000, 1500, 3500, 2500, 3000} {
			status, data := admin.do("PUT", fmt.Sprintf("/api/users/%d/quota", uid["conc-u1"]), map[string]any{"quotaBytes": qVal})
			if status != 200 && status != 409 {
				t.Errorf("stress set user quota status=%d: %s", status, data)
			}
		}
	}()
	go func() {
		defer stressWG.Done()
		<-stressGate
		for i := 0; i < 6; i++ {
			target := orgB.ID
			if i%2 == 1 {
				target = orgA.ID
			}
			status, data := admin.do("PUT", fmt.Sprintf("/api/users/%d/organization", uid["conc-u2"]), map[string]any{"organizationId": target})
			if status != 204 && status != 409 {
				t.Errorf("stress move user status=%d: %s", status, data)
			}
		}
	}()

	close(stressGate)
	stressWG.Wait()

	// Verify zero leftover active reservations and clean org invariants after stress run.
	var finalUsers []apiManagedUserQuota
	decode(t, call(admin, "GET", "/managed-users", nil, 200), &finalUsers)
	for _, u := range finalUsers {
		if (u.Username == "conc-u1" || u.Username == "conc-u2") && u.UsedBytes != 0 {
			t.Fatalf("after stress cleanup user %s still has used=%d", u.Username, u.UsedBytes)
		}
	}
}
