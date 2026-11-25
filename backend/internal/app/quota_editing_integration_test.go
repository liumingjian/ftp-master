//go:build integration

package app_test

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/minio/minio-go/v7"
)

func countBucketObjects(t *testing.T, client *minio.Client, bucket string) int {
	t.Helper()
	n := 0
	for obj := range client.ListObjects(context.Background(), bucket, minio.ListObjectsOptions{Recursive: true}) {
		if obj.Err != nil {
			t.Fatal(obj.Err)
		}
		n++
	}
	return n
}

func TestTextOpenQuotaPrecheck(t *testing.T) {
	stores := startStores(t)
	clk := clock.NewFake(time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC))
	server := startService(t, stores.config, clk)
	admin := newBrowser(t, server)
	signInAsAdministrator(t, admin)

	call := func(b *browser, method, path string, body any, want int) []byte {
		t.Helper()
		status, data := b.do(method, "/api"+path, body)
		if status != want {
			t.Fatalf("%s %s: status=%d, want %d: %s", method, path, status, want, data)
		}
		return data
	}

	// Hierarchy:
	//   RootOrg (600 B initially, later lowered to 500 B)
	//     ├─ ChildOrg (200 B)
	//     │    ├─ capped (User Quota 100 B)
	//     │    └─ pooler (uncapped -> ChildOrg pool = 100 B)
	//     └─ HeavyOrg (no Org Quota -> passes transparently to RootOrg)
	//          ├─ heavy (User Quota 300 B)
	//          └─ rootpooler (uncapped -> RootOrg pool = 100 B)
	var rootOrg, childOrg, heavyOrg apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "RootOrg", "quotaBytes": 600}, 201), &rootOrg)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "ChildOrg", "parentId": rootOrg.ID, "quotaBytes": 200}, 201), &childOrg)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "HeavyOrg", "parentId": rootOrg.ID}, 201), &heavyOrg)

	csvBody := fmt.Sprintf(
		"username,display_name,password,organization_id\n"+
			"capped,Capped User,Pass12345!,%d\n"+
			"pooler,Pool User,Pass12345!,%d\n"+
			"heavy,Heavy User,Pass12345!,%d\n"+
			"rootpooler,Root Pool User,Pass12345!,%d\n"+
			"unlimited,Unlimited User,Pass12345!,1\n",
		childOrg.ID, childOrg.ID, heavyOrg.ID, heavyOrg.ID,
	)
	call(admin, "POST", "/users/import", map[string]any{"csv": csvBody}, 201)

	var users []apiManagedUserQuota
	decode(t, call(admin, "GET", "/managed-users", nil, 200), &users)
	userIDs := map[string]int64{}
	for _, u := range users {
		userIDs[u.Username] = u.ID
	}

	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["capped"]), map[string]any{"quotaBytes": 100}, 200)
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["heavy"]), map[string]any{"quotaBytes": 300}, 200)

	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/tree", map[string]any{"name": "TextQuotaDir"}, 201), &dir)
	for _, orgID := range []int64{rootOrg.ID, 1} {
		call(admin, "POST", fmt.Sprintf("/tree/%d/grants", dir.ID), map[string]any{
			"principalKind": "organization",
			"principalId":   orgID,
			"rights":        63,
			"scope":         "subtree",
		}, 201)
	}

	signInUser := func(username string) *browser {
		t.Helper()
		b := newBrowser(t, server)
		if status, body := b.signIn(username, "Pass12345!"); status != 200 {
			t.Fatalf("sign in %s: %d %+v", username, status, body)
		}
		return b
	}
	capped := signInUser("capped")
	pooler := signInUser("pooler")
	heavy := signInUser("heavy")
	rootpooler := signInUser("rootpooler")
	unlimited := signInUser("unlimited")

	// Upload a 60-byte text file authored by capped (capped now uses 60/100 B -> 40 B remaining, smaller than file size!).
	textContent := strings.Repeat("a", 60)
	fileID, _ := completeSingleUpload(t, server.URL, capped, dir.ID, "notes.txt", []byte(textContent), "")
	textPath := fmt.Sprintf("/tree/%d/text", fileID)

	// 1. Unlimited user opens notes.txt -> 200 with availableQuotaBytes: null.
	raw := call(unlimited, "GET", textPath, nil, 200)
	var rawMap map[string]any
	if err := json.Unmarshal(raw, &rawMap); err != nil {
		t.Fatal(err)
	}
	if val, present := rawMap["availableQuotaBytes"]; !present || val != nil {
		t.Fatalf("unlimited open expected availableQuotaBytes: null, got %s", raw)
	}

	// 2. Capped user has 40 B remaining (< 60 B file size) -> still allowed (200) with availableQuotaBytes == 40.
	var opened struct {
		VersionID           int64  `json:"versionId"`
		Content             string `json:"content"`
		AvailableQuotaBytes *int64 `json:"availableQuotaBytes"`
	}
	decode(t, call(capped, "GET", textPath, nil, 200), &opened)
	if opened.Content != textContent {
		t.Fatalf("content mismatch: got %q", opened.Content)
	}
	if opened.AvailableQuotaBytes == nil || *opened.AvailableQuotaBytes != 40 {
		t.Fatalf("availableQuotaBytes = %v, want 40", opened.AvailableQuotaBytes)
	}

	// 3. Lower capped's quota to 50 B (below 60 B usage => 0 B available) -> GET /tree/{id}/text returns 507 (user scope).
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["capped"]), map[string]any{"quotaBytes": 50}, 200)
	var refused apiQuotaExceeded
	decode(t, call(capped, "GET", textPath, nil, 507), &refused)
	if refused.Code != "quota_exceeded" || refused.Scope != "user" || refused.AvailableBytes != 0 || refused.RequiredBytes != 0 {
		t.Fatalf("unexpected user 507 payload: %+v", refused)
	}
	if !strings.Contains(refused.Message, "个人存储配额") {
		t.Fatalf("expected personal quota Chinese attribution, got %q", refused.Message)
	}

	// 4. Restore capped's quota to 100 B (ChildOrg pool = 100 B, ChildOrg total remaining = 140 B).
	// Exhaust ChildOrg's unallocated pool with pooler (100 B) -> pooler blocked with organization_pool while ChildOrg total still has 40 B.
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["capped"]), map[string]any{"quotaBytes": 100}, 200)
	completeSingleUpload(t, server.URL, pooler, dir.ID, "pool-fill.bin", make([]byte, 100), "")
	var poolRefused apiQuotaExceeded
	decode(t, call(pooler, "GET", textPath, nil, 507), &poolRefused)
	if poolRefused.Code != "quota_exceeded" || poolRefused.Scope != "organization_pool" || poolRefused.AvailableBytes != 0 {
		t.Fatalf("unexpected pool 507 payload: %+v", poolRefused)
	}
	if poolRefused.OrganizationName == nil || *poolRefused.OrganizationName != "ChildOrg" {
		t.Fatalf("expected ChildOrg attribution, got %+v", poolRefused)
	}
	if !strings.Contains(poolRefused.Message, "ChildOrg") || !strings.Contains(poolRefused.Message, "未分配配额池") {
		t.Fatalf("expected org pool Chinese attribution, got %q", poolRefused.Message)
	}

	// 5. Fill RootOrg to 500 B (60 + 100 + 100 + 240) and lower RootOrg cap to 500 B (valid: allocated = 200 + 300 = 500).
	// Heavy still has 60 B personal quota left (240/300), but RootOrg total ceiling is 500/500 (0 B left) -> organization_total.
	completeSingleUpload(t, server.URL, rootpooler, dir.ID, "root-pool-fill.bin", make([]byte, 100), "")
	completeSingleUpload(t, server.URL, heavy, dir.ID, "heavy-fill.bin", make([]byte, 240), "")
	call(admin, "PATCH", fmt.Sprintf("/organizations/%d", rootOrg.ID), map[string]any{"name": "RootOrg", "quotaBytes": 500}, 200)
	var totalRefused apiQuotaExceeded
	decode(t, call(heavy, "GET", textPath, nil, 507), &totalRefused)
	if totalRefused.Code != "quota_exceeded" || totalRefused.Scope != "organization_total" || totalRefused.AvailableBytes != 0 {
		t.Fatalf("unexpected org total 507 payload: %+v", totalRefused)
	}
	if totalRefused.OrganizationName == nil || *totalRefused.OrganizationName != "RootOrg" {
		t.Fatalf("expected RootOrg attribution, got %+v", totalRefused)
	}
	if !strings.Contains(totalRefused.Message, "RootOrg") || !strings.Contains(totalRefused.Message, "总存储配额") {
		t.Fatalf("expected org total Chinese attribution, got %q", totalRefused.Message)
	}

	// 6. Administrator with 0-byte User Quota is equally blocked on GET /tree/{id}/text.
	var adminID int64
	for _, u := range users {
		if u.Username == "admin" {
			adminID = u.ID
		}
	}
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", adminID), map[string]any{"quotaBytes": 0}, 200)
	var adminRefused apiQuotaExceeded
	decode(t, call(admin, "GET", textPath, nil, 507), &adminRefused)
	if adminRefused.Code != "quota_exceeded" || adminRefused.Scope != "user" {
		t.Fatalf("expected admin user-scope 507, got %+v", adminRefused)
	}
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", adminID), map[string]any{"quotaBytes": nil}, 200)

	// Verify only the 2 successful opens produced text_open audit events (no success/failure events on blocked opens).
	events := readAuditEvents(t, stores.config.DatabaseURL)
	textOpenCount := 0
	for _, ev := range events {
		if ev.Action == "text_open" {
			textOpenCount++
		}
	}
	if textOpenCount != 2 {
		t.Fatalf("text_open audit count = %d, want 2", textOpenCount)
	}
}

func TestTextSaveQuotaEnforcementAuditAndNoOrphanObject(t *testing.T) {
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

	// Hierarchy:
	//   RootOrg (300 B initially, later lowered to 280 B)
	//     ├─ ChildOrg (150 B)
	//     │    ├─ capped (User Quota 100 B)
	//     │    └─ pooler (uncapped -> ChildOrg pool = 50 B)
	//     └─ HeavyOrg (uncapped intermediate -> RootOrg pool = 50 B initially)
	//          ├─ heavy (User Quota 100 B)
	//          └─ rootpooler (uncapped -> uses 50 B from RootOrg pool)
	var rootOrg, childOrg, heavyOrg apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "RootOrg", "quotaBytes": 300}, 201), &rootOrg)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "ChildOrg", "parentId": rootOrg.ID, "quotaBytes": 150}, 201), &childOrg)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "HeavyOrg", "parentId": rootOrg.ID}, 201), &heavyOrg)

	csvBody := fmt.Sprintf(
		"username,display_name,password,organization_id\n"+
			"capped,Capped Editor,Pass12345!,%d\n"+
			"pooler,Pool Editor,Pass12345!,%d\n"+
			"heavy,Heavy Editor,Pass12345!,%d\n"+
			"rootpooler,Root Pool User,Pass12345!,%d\n",
		childOrg.ID, childOrg.ID, heavyOrg.ID, heavyOrg.ID,
	)
	call(admin, "POST", "/users/import", map[string]any{"csv": csvBody}, 201)

	var users []apiManagedUserQuota
	decode(t, call(admin, "GET", "/managed-users", nil, 200), &users)
	userIDs := map[string]int64{}
	for _, u := range users {
		userIDs[u.Username] = u.ID
	}
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["capped"]), map[string]any{"quotaBytes": 100}, 200)
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["heavy"]), map[string]any{"quotaBytes": 100}, 200)

	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/tree", map[string]any{"name": "TextSaveDir"}, 201), &dir)
	call(admin, "POST", fmt.Sprintf("/tree/%d/grants", dir.ID), map[string]any{
		"principalKind": "organization",
		"principalId":   rootOrg.ID,
		"rights":        63,
		"scope":         "subtree",
	}, 201)

	signInUser := func(username string) *browser {
		t.Helper()
		b := newBrowser(t, server)
		if status, body := b.signIn(username, "Pass12345!"); status != 200 {
			t.Fatalf("sign in %s: %d %+v", username, status, body)
		}
		return b
	}
	capped := signInUser("capped")
	pooler := signInUser("pooler")
	heavy := signInUser("heavy")
	rootpooler := signInUser("rootpooler")

	// capped uploads a 60-byte text file -> 40 B remaining on User Quota.
	fileID, v1 := completeSingleUpload(t, server.URL, capped, dir.ID, "notes.txt", []byte(strings.Repeat("a", 60)), "")
	textPath := fmt.Sprintf("/tree/%d/text", fileID)
	versionsPath := fmt.Sprintf("/tree/%d/versions", fileID)

	countVersions := func() int {
		t.Helper()
		var vs []struct {
			ID int64 `json:"id"`
		}
		decode(t, call(admin, "GET", versionsPath, nil, 200), &vs)
		return len(vs)
	}

	objectsBefore := countBucketObjects(t, minioClient, stores.config.MinIOBucket)

	// 1. Multi-byte UTF-8 Chinese save (15 chars = 45 bytes > 40 B available) must fail with 507,
	// leave zero new version, leave zero orphaned MinIO object, and record a failed text_save audit event.
	utf8Over := "中文测试内容一二三四五六七八九" // 15 runes, 45 UTF-8 bytes
	if len([]byte(utf8Over)) != 45 {
		t.Fatalf("expected 45 UTF-8 bytes, got %d", len([]byte(utf8Over)))
	}
	var userRefused apiQuotaExceeded
	decode(t, call(capped, "PUT", textPath, map[string]any{"baseVersionId": v1, "content": utf8Over}, 507), &userRefused)
	if userRefused.Code != "quota_exceeded" || userRefused.Scope != "user" || userRefused.RequiredBytes != 45 || userRefused.AvailableBytes != 40 {
		t.Fatalf("unexpected user save 507: %+v", userRefused)
	}
	if !strings.Contains(userRefused.Message, "个人存储配额") || !strings.Contains(userRefused.Message, "40 B") || !strings.Contains(userRefused.Message, "45 B") {
		t.Fatalf("unexpected Chinese message: %q", userRefused.Message)
	}
	if got := countVersions(); got != 1 {
		t.Fatalf("versions after refused save = %d, want 1", got)
	}
	if got := countBucketObjects(t, minioClient, stores.config.MinIOBucket); got != objectsBefore {
		t.Fatalf("MinIO objects after refused save = %d, want %d (orphaned object leaked!)", got, objectsBefore)
	}

	// 2. Saving 39 UTF-8 bytes (<= 40 B available) succeeds and creates version 2.
	utf8Fit := "中文测试内容一二三四五六七" // 13 runes, 39 UTF-8 bytes
	var receipt struct {
		VersionID int64 `json:"versionId"`
	}
	decode(t, call(capped, "PUT", textPath, map[string]any{"baseVersionId": v1, "content": utf8Fit}, 201), &receipt)
	v2 := receipt.VersionID
	if got := countVersions(); got != 2 {
		t.Fatalf("versions after fit save = %d, want 2", got)
	}

	// 3. Stale baseVersionId returns 409 even if content exceeds remaining 1 B quota.
	call(capped, "PUT", textPath, map[string]any{"baseVersionId": v1, "content": strings.Repeat("z", 50)}, 409)

	// 4. Lower capped's quota to 50 B (over quota: 99/50); zero-byte text save ("") still succeeds!
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["capped"]), map[string]any{"quotaBytes": 50}, 200)
	var emptyReceipt struct {
		VersionID int64 `json:"versionId"`
	}
	decode(t, call(capped, "PUT", textPath, map[string]any{"baseVersionId": v2, "content": ""}, 201), &emptyReceipt)
	v3 := emptyReceipt.VersionID

	// Restore capped's quota back to 100 B so ChildOrg pool is 50 B and ChildOrg total has 51 B remaining.
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["capped"]), map[string]any{"quotaBytes": 100}, 200)

	// 5. Uncapped pooler tries to save 55 bytes (> 50 B ChildOrg unallocated pool) -> 507 organization_pool, no orphan object.
	objectsBefore = countBucketObjects(t, minioClient, stores.config.MinIOBucket)
	var poolRefused apiQuotaExceeded
	decode(t, call(pooler, "PUT", textPath, map[string]any{"baseVersionId": v3, "content": strings.Repeat("p", 55)}, 507), &poolRefused)
	if poolRefused.Code != "quota_exceeded" || poolRefused.Scope != "organization_pool" || poolRefused.RequiredBytes != 55 || poolRefused.AvailableBytes != 50 {
		t.Fatalf("unexpected pool save 507: %+v", poolRefused)
	}
	if poolRefused.OrganizationName == nil || *poolRefused.OrganizationName != "ChildOrg" {
		t.Fatalf("expected ChildOrg attribution, got %+v", poolRefused)
	}
	if got := countBucketObjects(t, minioClient, stores.config.MinIOBucket); got != objectsBefore {
		t.Fatalf("MinIO objects leaked on pool refusal: got %d, want %d", got, objectsBefore)
	}

	// 6. Constrain RootOrg total ceiling:
	// Currently ChildOrg used = 99 B. rootpooler uploads 50 B (RootOrg pool = 50 B), heavy uploads 60 B (heavy has 40 B personal left).
	// Total RootOrg used = 99 + 50 + 60 = 209 B. Lower RootOrg from 300 B to 250 B (valid: allocated = ChildOrg 150 + heavy 100 = 250).
	// Now RootOrg total has 250 - 209 = 41 B? Wait: heavy has 40 B personal left vs 41 B org total.
	// Have pooler upload 21 B (within 50 B ChildOrg pool) -> RootOrg total used = 230 B => 20 B RootOrg total left (< 40 B heavy personal left)!
	completeSingleUpload(t, server.URL, rootpooler, dir.ID, "rootpool.bin", make([]byte, 50), "")
	completeSingleUpload(t, server.URL, heavy, dir.ID, "heavy.bin", make([]byte, 60), "")
	completeSingleUpload(t, server.URL, pooler, dir.ID, "pooler.bin", make([]byte, 21), "")
	call(admin, "PATCH", fmt.Sprintf("/organizations/%d", rootOrg.ID), map[string]any{"name": "RootOrg", "quotaBytes": 250}, 200)

	objectsBefore = countBucketObjects(t, minioClient, stores.config.MinIOBucket)
	var totalRefused apiQuotaExceeded
	decode(t, call(heavy, "PUT", textPath, map[string]any{"baseVersionId": v3, "content": strings.Repeat("h", 30)}, 507), &totalRefused)
	if totalRefused.Code != "quota_exceeded" || totalRefused.Scope != "organization_total" || totalRefused.RequiredBytes != 30 || totalRefused.AvailableBytes != 20 {
		t.Fatalf("unexpected org total save 507: %+v", totalRefused)
	}
	if totalRefused.OrganizationName == nil || *totalRefused.OrganizationName != "RootOrg" {
		t.Fatalf("expected RootOrg attribution, got %+v", totalRefused)
	}
	if got := countBucketObjects(t, minioClient, stores.config.MinIOBucket); got != objectsBefore {
		t.Fatalf("MinIO objects leaked on org total refusal: got %d, want %d", got, objectsBefore)
	}

	// 7. Query failed text_save Audit Events via POST /api/audit/query and verify structured quota detail fields.
	var auditResp struct {
		Events []struct {
			Username string         `json:"username"`
			Action   string         `json:"action"`
			Outcome  string         `json:"outcome"`
			ItemID   *int64         `json:"itemId"`
			Path     string         `json:"path"`
			Detail   map[string]any `json:"detail"`
		} `json:"events"`
	}
	decode(t, call(admin, "POST", "/audit/query", map[string]any{
		"from":         "2026-11-25T00:00:00Z",
		"to":           "2026-11-26T00:00:00Z",
		"action":       "text_save",
		"failuresOnly": true,
	}, 200), &auditResp)

	if len(auditResp.Events) != 3 {
		t.Fatalf("failed text_save audit events = %d, want 3: %+v", len(auditResp.Events), auditResp.Events)
	}
	byUser := map[string]map[string]any{}
	for _, ev := range auditResp.Events {
		if ev.Outcome != "failure" || ev.ItemID == nil || *ev.ItemID != fileID || ev.Path != "/TextSaveDir/notes.txt" {
			t.Fatalf("unexpected audit event envelope: %+v", ev)
		}
		byUser[ev.Username] = ev.Detail
	}
	if byUser["capped"]["reason"] != "quota_exceeded" || byUser["capped"]["scope"] != "user" || byUser["capped"]["requiredBytes"] != float64(45) || byUser["capped"]["availableBytes"] != float64(40) {
		t.Fatalf("unexpected capped audit detail: %+v", byUser["capped"])
	}
	if byUser["pooler"]["reason"] != "quota_exceeded" || byUser["pooler"]["scope"] != "organization_pool" || byUser["pooler"]["organizationName"] != "ChildOrg" || byUser["pooler"]["requiredBytes"] != float64(55) || byUser["pooler"]["availableBytes"] != float64(50) {
		t.Fatalf("unexpected pooler audit detail: %+v", byUser["pooler"])
	}
	if byUser["heavy"]["reason"] != "quota_exceeded" || byUser["heavy"]["scope"] != "organization_total" || byUser["heavy"]["organizationName"] != "RootOrg" || byUser["heavy"]["requiredBytes"] != float64(30) || byUser["heavy"]["availableBytes"] != float64(20) {
		t.Fatalf("unexpected heavy audit detail: %+v", byUser["heavy"])
	}
}

func TestOfficeStartQuotaPrecheckAndUnrestrictedPreview(t *testing.T) {
	stores := startStores(t)
	clk := clock.NewFake(time.Date(2026, 11, 25, 14, 0, 0, 0, time.UTC))
	server := startService(t, stores.config, clk)
	admin := newBrowser(t, server)
	signInAsAdministrator(t, admin)

	call := func(b *browser, method, path string, body any, want int) []byte {
		t.Helper()
		status, data := b.do(method, "/api"+path, body)
		if status != want {
			t.Fatalf("%s %s: status=%d, want %d: %s", method, path, status, want, data)
		}
		return data
	}

	docxBytes := officeZip(t, false)
	docLen := int64(len(docxBytes))

	// Hierarchy sized dynamically around docLen so tests stay clear and exact:
	//   RootOrg: docLen*4 initially -> lowered to docLen*3 + 50 later
	//     ├─ ChildOrg: docLen*2
	//     │    ├─ capped (User Quota docLen + 50)
	//     │    └─ pooler (uncapped -> ChildOrg pool = docLen - 50)
	//     └─ HeavyOrg (uncapped intermediate)
	//          ├─ heavy (User Quota docLen + 50)
	//          └─ rootpooler (uncapped -> RootOrg pool = docLen - 50 initially)
	var rootOrg, childOrg, heavyOrg apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "RootOrg", "quotaBytes": docLen * 4}, 201), &rootOrg)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "ChildOrg", "parentId": rootOrg.ID, "quotaBytes": docLen * 2}, 201), &childOrg)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "HeavyOrg", "parentId": rootOrg.ID}, 201), &heavyOrg)

	csvBody := fmt.Sprintf(
		"username,display_name,password,organization_id\n"+
			"capped,Capped Office,Pass12345!,%d\n"+
			"pooler,Pool Office,Pass12345!,%d\n"+
			"heavy,Heavy Office,Pass12345!,%d\n"+
			"rootpooler,Root Pool Office,Pass12345!,%d\n"+
			"unlimited,Unlimited Office,Pass12345!,1\n",
		childOrg.ID, childOrg.ID, heavyOrg.ID, heavyOrg.ID,
	)
	call(admin, "POST", "/users/import", map[string]any{"csv": csvBody}, 201)

	var users []apiManagedUserQuota
	decode(t, call(admin, "GET", "/managed-users", nil, 200), &users)
	userIDs := map[string]int64{}
	for _, u := range users {
		userIDs[u.Username] = u.ID
	}
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["capped"]), map[string]any{"quotaBytes": docLen + 50}, 200)
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["heavy"]), map[string]any{"quotaBytes": docLen + 50}, 200)

	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/tree", map[string]any{"name": "OfficeStartDir"}, 201), &dir)
	for _, orgID := range []int64{rootOrg.ID, 1} {
		call(admin, "POST", fmt.Sprintf("/tree/%d/grants", dir.ID), map[string]any{
			"principalKind": "organization",
			"principalId":   orgID,
			"rights":        63,
			"scope":         "subtree",
		}, 201)
	}

	signInUser := func(username string) *browser {
		t.Helper()
		b := newBrowser(t, server)
		if status, body := b.signIn(username, "Pass12345!"); status != 200 {
			t.Fatalf("sign in %s: %d %+v", username, status, body)
		}
		return b
	}
	capped := signInUser("capped")
	pooler := signInUser("pooler")
	heavy := signInUser("heavy")
	rootpooler := signInUser("rootpooler")
	unlimited := signInUser("unlimited")

	// capped uploads report.docx (size docLen) -> capped now has 50 B remaining (< docLen).
	fileID, _ := completeSingleUpload(t, server.URL, capped, dir.ID, "report.docx", docxBytes, "")
	editPath := fmt.Sprintf("/files/%d/office-edits", fileID)

	// 1. Unlimited user starts write-mode edit -> 201, saveUrl present, availableQuotaBytes nil.
	var unlimitedPermit struct {
		SaveURL             *string `json:"saveUrl"`
		AvailableQuotaBytes *int64  `json:"availableQuotaBytes"`
	}
	decode(t, call(unlimited, "POST", editPath, map[string]any{}, 201), &unlimitedPermit)
	if unlimitedPermit.SaveURL == nil || unlimitedPermit.AvailableQuotaBytes != nil {
		t.Fatalf("unexpected unlimited permit: %+v", unlimitedPermit)
	}

	// 2. Capped user with 50 B remaining (> 0, < docLen) starts write-mode edit -> 201 with availableQuotaBytes == 50.
	var tightPermit struct {
		SaveURL             *string `json:"saveUrl"`
		AvailableQuotaBytes *int64  `json:"availableQuotaBytes"`
	}
	decode(t, call(capped, "POST", editPath, map[string]any{}, 201), &tightPermit)
	if tightPermit.SaveURL == nil || tightPermit.AvailableQuotaBytes == nil || *tightPermit.AvailableQuotaBytes != 50 {
		t.Fatalf("expected availableQuotaBytes == 50, got %+v", tightPermit)
	}

	// 3. Lower capped's quota below current usage -> write-mode edit returns 507 (user scope),
	// while read-only preview (preview: true) stays 201 and delivers bytes through Document Gateway.
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["capped"]), map[string]any{"quotaBytes": docLen - 10}, 200)
	var userRefused apiQuotaExceeded
	decode(t, call(capped, "POST", editPath, map[string]any{}, 507), &userRefused)
	if userRefused.Code != "quota_exceeded" || userRefused.Scope != "user" || userRefused.AvailableBytes != 0 || userRefused.RequiredBytes != 0 {
		t.Fatalf("unexpected user office start 507: %+v", userRefused)
	}
	if !strings.Contains(userRefused.Message, "个人存储配额") {
		t.Fatalf("expected personal quota attribution, got %q", userRefused.Message)
	}

	var previewPermit struct {
		DocumentURL string  `json:"documentUrl"`
		SaveURL     *string `json:"saveUrl"`
	}
	decode(t, call(capped, "POST", editPath, map[string]any{"preview": true}, 201), &previewPermit)
	if previewPermit.SaveURL != nil {
		t.Fatalf("preview permit must omit saveUrl, got %q", *previewPermit.SaveURL)
	}
	res, err := http.Get(server.URL + previewPermit.DocumentURL)
	if err != nil {
		t.Fatal(err)
	}
	gotDoc, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || len(gotDoc) != len(docxBytes) {
		t.Fatalf("preview gateway delivery failed: status=%d len=%d want %d", res.StatusCode, len(gotDoc), len(docxBytes))
	}

	// 4. Restore capped to docLen+50 -> ChildOrg pool = docLen-50. Exhaust pool with pooler -> 507 organization_pool; preview stays 201!
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["capped"]), map[string]any{"quotaBytes": docLen + 50}, 200)
	completeSingleUpload(t, server.URL, pooler, dir.ID, "pool.bin", make([]byte, docLen-50), "")
	var poolRefused apiQuotaExceeded
	decode(t, call(pooler, "POST", editPath, map[string]any{}, 507), &poolRefused)
	if poolRefused.Code != "quota_exceeded" || poolRefused.Scope != "organization_pool" || poolRefused.OrganizationName == nil || *poolRefused.OrganizationName != "ChildOrg" {
		t.Fatalf("unexpected pool office start 507: %+v", poolRefused)
	}
	call(pooler, "POST", editPath, map[string]any{"preview": true}, 201)

	// 5. Fill RootOrg to docLen*3 + 50: ChildOrg uses docLen + (docLen-50) = 2*docLen - 50;
	// rootpooler uploads docLen-50 (RootOrg pool = 4*docLen - 2*docLen - (docLen+50) = docLen - 50);
	// heavy uploads 150 -> RootOrg total used = (2*docLen - 50) + (docLen - 50) + 150 = 3*docLen + 50!
	// Lower RootOrg from 4*docLen to 3*docLen + 50 (valid: allocated = 2*docLen + (docLen+50) = 3*docLen + 50).
	// Now heavy has docLen-100 personal left (> 0), but RootOrg total has 0 left -> organization_total; preview stays 201!
	completeSingleUpload(t, server.URL, rootpooler, dir.ID, "rpool.bin", make([]byte, docLen-50), "")
	completeSingleUpload(t, server.URL, heavy, dir.ID, "heavy.bin", make([]byte, 150), "")
	call(admin, "PATCH", fmt.Sprintf("/organizations/%d", rootOrg.ID), map[string]any{"name": "RootOrg", "quotaBytes": docLen*3 + 50}, 200)
	var totalRefused apiQuotaExceeded
	decode(t, call(heavy, "POST", editPath, map[string]any{}, 507), &totalRefused)
	if totalRefused.Code != "quota_exceeded" || totalRefused.Scope != "organization_total" || totalRefused.OrganizationName == nil || *totalRefused.OrganizationName != "RootOrg" {
		t.Fatalf("unexpected org total office start 507: %+v", totalRefused)
	}
	call(heavy, "POST", editPath, map[string]any{"preview": true}, 201)

	// 6. Administrator with 0-byte User Quota is blocked on write-mode edit (507) but allowed on read-only preview (201).
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["admin"]), map[string]any{"quotaBytes": 0}, 200)
	call(admin, "POST", editPath, map[string]any{}, 507)
	call(admin, "POST", editPath, map[string]any{"preview": true}, 201)
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["admin"]), map[string]any{"quotaBytes": nil}, 200)

	// Only the 2 allowed write-mode starts created open_for_edit audit events.
	openCount := 0
	for _, ev := range readAuditEvents(t, stores.config.DatabaseURL) {
		if ev.Action == "open_for_edit" {
			openCount++
		}
	}
	if openCount != 2 {
		t.Fatalf("open_for_edit audit count = %d, want 2", openCount)
	}
}

func submitOfficeSave(t *testing.T, serverURL string, b *browser, saveURL, mode string, data []byte) (int, map[string]any, []byte) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	if mode == "writer" {
		part, err := w.CreateFormFile("filedata", "report.docx")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = part.Write(data); err != nil {
			t.Fatal(err)
		}
		_ = w.WriteField("md5sum", fmt.Sprintf("%x", md5.Sum(data)))
		_ = w.WriteField("filename", "report.docx")
	} else {
		part, err := w.CreatePart(textproto.MIMEHeader{
			"Content-Disposition": {`form-data; name="file"; filename=""`},
			"Content-Type":        {"application/octet-stream"},
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = part.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest("POST", serverURL+saveURL, &buf)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	if b.cookie != nil {
		req.AddCookie(b.cookie)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	var receipt map[string]any
	decode(t, raw, &receipt)
	return res.StatusCode, receipt, raw
}

func TestOfficeSaveQuotaEnforcementReceiptAuditAndNoOrphanObject(t *testing.T) {
	stores := startStores(t)
	clk := clock.NewFake(time.Date(2026, 11, 25, 15, 0, 0, 0, time.UTC))
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

	docxBytes := officeZip(t, false)
	xlsxBytes := officeZip(t, true)
	docLen := int64(len(docxBytes))
	xlsLen := int64(len(xlsxBytes))

	// Hierarchy:
	//   RootOrg: initial large cap (10000 B), later tightened to test organization_total
	//     ├─ ChildOrg: cappedUserQuota + (xlsLen - 20)
	//     │    ├─ capped (User Quota = docLen*2 - 10)
	//     │    └─ pooler (uncapped -> ChildOrg pool = xlsLen - 20)
	//     └─ HeavyOrg (uncapped intermediate)
	//          ├─ heavy (User Quota = xlsLen * 3)
	//          └─ rootpooler (uncapped)
	cappedInitialQuota := docLen*2 - 10
	childOrgQuota := cappedInitialQuota + (xlsLen - 20)

	var rootOrg, childOrg, heavyOrg apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "RootOrg", "quotaBytes": int64(10000)}, 201), &rootOrg)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "ChildOrg", "parentId": rootOrg.ID, "quotaBytes": childOrgQuota}, 201), &childOrg)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "HeavyOrg", "parentId": rootOrg.ID}, 201), &heavyOrg)

	csvBody := fmt.Sprintf(
		"username,display_name,password,organization_id\n"+
			"capped,Capped Writer,Pass12345!,%d\n"+
			"pooler,Pool ET,Pass12345!,%d\n"+
			"heavy,Heavy ET,Pass12345!,%d\n"+
			"rootpooler,Root Pool,Pass12345!,%d\n",
		childOrg.ID, childOrg.ID, heavyOrg.ID, heavyOrg.ID,
	)
	call(admin, "POST", "/users/import", map[string]any{"csv": csvBody}, 201)

	var users []apiManagedUserQuota
	decode(t, call(admin, "GET", "/managed-users", nil, 200), &users)
	userIDs := map[string]int64{}
	for _, u := range users {
		userIDs[u.Username] = u.ID
	}
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["capped"]), map[string]any{"quotaBytes": cappedInitialQuota}, 200)
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["heavy"]), map[string]any{"quotaBytes": xlsLen * 3}, 200)

	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/tree", map[string]any{"name": "OfficeSaveDir"}, 201), &dir)
	call(admin, "POST", fmt.Sprintf("/tree/%d/grants", dir.ID), map[string]any{
		"principalKind": "organization",
		"principalId":   rootOrg.ID,
		"rights":        63,
		"scope":         "subtree",
	}, 201)

	signInUser := func(username string) *browser {
		t.Helper()
		b := newBrowser(t, server)
		if status, body := b.signIn(username, "Pass12345!"); status != 200 {
			t.Fatalf("sign in %s: %d %+v", username, status, body)
		}
		return b
	}
	capped := signInUser("capped")
	pooler := signInUser("pooler")
	heavy := signInUser("heavy")
	rootpooler := signInUser("rootpooler")

	// capped uploads report.docx (docLen) -> docLen - 10 B left on User Quota (positive, so edit starts!).
	// admin uploads sheet.xlsx (xlsLen) -> belongs to admin (org 1), so does not consume RootOrg quota.
	docxFileID, _ := completeSingleUpload(t, server.URL, capped, dir.ID, "report.docx", docxBytes, "")
	xlsxFileID, _ := completeSingleUpload(t, server.URL, admin, dir.ID, "sheet.xlsx", xlsxBytes, "")

	startAndDeliver := func(b *browser, fileID int64) string {
		t.Helper()
		var permit struct {
			DocumentURL string `json:"documentUrl"`
			SaveURL     string `json:"saveUrl"`
		}
		decode(t, call(b, "POST", fmt.Sprintf("/files/%d/office-edits", fileID), map[string]any{}, 201), &permit)
		res, err := http.Get(server.URL + permit.DocumentURL)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("deliver %s: %d", permit.DocumentURL, res.StatusCode)
		}
		return permit.SaveURL
	}

	countVersions := func(fileID int64) int {
		t.Helper()
		var vs []struct {
			ID int64 `json:"id"`
		}
		decode(t, call(admin, "GET", fmt.Sprintf("/tree/%d/versions", fileID), nil, 200), &vs)
		return len(vs)
	}

	// 1. Writer (docx) save exceeding User Quota -> HTTP 507 with exact WPS receipt {Success: false, Message: ..., Data: null},
	// zero new File Version, zero orphaned MinIO object!
	cappedSaveURL := startAndDeliver(capped, docxFileID)
	objectsBefore := countBucketObjects(t, minioClient, stores.config.MinIOBucket)
	status, receipt, raw := submitOfficeSave(t, server.URL, capped, cappedSaveURL, "writer", docxBytes)
	if status != 507 {
		t.Fatalf("expected 507 on user quota Office save, got %d: %s", status, raw)
	}
	if receipt["Success"] != false {
		t.Fatalf("expected Success: false, got %s", raw)
	}
	if dataVal, hasData := receipt["Data"]; !hasData || dataVal != nil {
		t.Fatalf("expected Data: null, got %s", raw)
	}
	msg, _ := receipt["Message"].(string)
	if !strings.Contains(msg, "个人存储配额") {
		t.Fatalf("expected personal quota Chinese attribution in receipt Message, got %q", msg)
	}
	if got := countVersions(docxFileID); got != 1 {
		t.Fatalf("docx versions after refused save = %d, want 1", got)
	}
	if got := countBucketObjects(t, minioClient, stores.config.MinIOBucket); got != objectsBefore {
		t.Fatalf("MinIO objects leaked on refused docx save: got %d, want %d", got, objectsBefore)
	}

	// 2. Raise capped's quota (and ChildOrg proportionally so pool stays xlsLen - 20) -> retrying the SAME delivered permit succeeds!
	call(admin, "PATCH", fmt.Sprintf("/organizations/%d", childOrg.ID), map[string]any{"name": "ChildOrg", "parentId": rootOrg.ID, "quotaBytes": docLen*2 + (xlsLen - 20)}, 200)
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["capped"]), map[string]any{"quotaBytes": docLen * 2}, 200)
	status, receipt, raw = submitOfficeSave(t, server.URL, capped, cappedSaveURL, "writer", docxBytes)
	if status != 200 || receipt["Success"] != true {
		t.Fatalf("expected retry on same permit to succeed, got %d: %s", status, raw)
	}
	if got := countVersions(docxFileID); got != 2 {
		t.Fatalf("docx versions after retry = %d, want 2", got)
	}

	// 3. ET (xlsx) save by uncapped pooler exceeding ChildOrg unallocated pool (xlsLen - 20 B available < xlsLen B) -> 507 WPS receipt!
	poolerSaveURL := startAndDeliver(pooler, xlsxFileID)
	objectsBefore = countBucketObjects(t, minioClient, stores.config.MinIOBucket)
	status, receipt, raw = submitOfficeSave(t, server.URL, pooler, poolerSaveURL, "et", xlsxBytes)
	if status != 507 || receipt["Success"] != false {
		t.Fatalf("expected 507 WPS refusal for pooler ET save, got %d: %s", status, raw)
	}
	if dataVal, hasData := receipt["Data"]; !hasData || dataVal != nil {
		t.Fatalf("expected Data: null for pooler, got %s", raw)
	}
	msg, _ = receipt["Message"].(string)
	if !strings.Contains(msg, "ChildOrg") || !strings.Contains(msg, "未分配配额池") {
		t.Fatalf("expected ChildOrg pool attribution in receipt Message, got %q", msg)
	}
	if got := countVersions(xlsxFileID); got != 1 {
		t.Fatalf("xlsx versions after pooler refusal = %d, want 1", got)
	}
	if got := countBucketObjects(t, minioClient, stores.config.MinIOBucket); got != objectsBefore {
		t.Fatalf("MinIO objects leaked on pooler ET refusal: got %d, want %d", got, objectsBefore)
	}

	// 4. Constrain RootOrg total ceiling so heavy has ample personal quota (xlsLen * 3) but RootOrg only has (xlsLen - 15) B left!
	// Currently ChildOrg quota = docLen*2 + xlsLen - 20, ChildOrg used = docLen*2.
	// RootOrg allocated = ChildOrg (docLen*2 + xlsLen - 20) + heavy (xlsLen*3) = docLen*2 + xlsLen*4 - 20.
	// Have rootpooler upload (xlsLen*3 + 15) B while RootOrg is 10000 B (RootOrg pool = 10000 - allocated > xlsLen*3 + 15).
	// Total RootOrg used becomes docLen*2 + xlsLen*3 + 15.
	// Lower RootOrg to allocated = docLen*2 + xlsLen*4 - 20 -> RootOrg remaining = (xlsLen*4 - 20) - (xlsLen*3 + 15) = xlsLen - 35 B!
	rootAllocated := (docLen*2 + (xlsLen - 20)) + (xlsLen * 3)
	completeSingleUpload(t, server.URL, rootpooler, dir.ID, "root-fill.bin", make([]byte, xlsLen*3+15), "")
	call(admin, "PATCH", fmt.Sprintf("/organizations/%d", rootOrg.ID), map[string]any{"name": "RootOrg", "quotaBytes": rootAllocated}, 200)

	heavySaveURL := startAndDeliver(heavy, xlsxFileID)
	objectsBefore = countBucketObjects(t, minioClient, stores.config.MinIOBucket)
	status, receipt, raw = submitOfficeSave(t, server.URL, heavy, heavySaveURL, "et", xlsxBytes)
	if status != 507 || receipt["Success"] != false {
		t.Fatalf("expected 507 WPS refusal for heavy ET save, got %d: %s", status, raw)
	}
	if dataVal, hasData := receipt["Data"]; !hasData || dataVal != nil {
		t.Fatalf("expected Data: null for heavy, got %s", raw)
	}
	msg, _ = receipt["Message"].(string)
	if !strings.Contains(msg, "RootOrg") || !strings.Contains(msg, "总存储配额") {
		t.Fatalf("expected RootOrg total attribution in receipt Message, got %q", msg)
	}
	if got := countVersions(xlsxFileID); got != 1 {
		t.Fatalf("xlsx versions after heavy refusal = %d, want 1", got)
	}
	if got := countBucketObjects(t, minioClient, stores.config.MinIOBucket); got != objectsBefore {
		t.Fatalf("MinIO objects leaked on heavy ET refusal: got %d, want %d", got, objectsBefore)
	}

	// 5. Query failed office_save Audit Events via POST /api/audit/query and verify structured quota details.
	var auditResp struct {
		Events []struct {
			Username string         `json:"username"`
			Action   string         `json:"action"`
			Outcome  string         `json:"outcome"`
			ItemID   *int64         `json:"itemId"`
			Path     string         `json:"path"`
			Detail   map[string]any `json:"detail"`
		} `json:"events"`
	}
	decode(t, call(admin, "POST", "/audit/query", map[string]any{
		"from":         "2026-11-25T00:00:00Z",
		"to":           "2026-11-26T00:00:00Z",
		"action":       "office_save",
		"failuresOnly": true,
	}, 200), &auditResp)

	if len(auditResp.Events) != 3 {
		t.Fatalf("failed office_save audit events = %d, want 3: %+v", len(auditResp.Events), auditResp.Events)
	}
	byUser := map[string]struct {
		itemID int64
		path   string
		detail map[string]any
	}{}
	for _, ev := range auditResp.Events {
		if ev.Outcome != "failure" || ev.ItemID == nil {
			t.Fatalf("unexpected audit event envelope: %+v", ev)
		}
		byUser[ev.Username] = struct {
			itemID int64
			path   string
			detail map[string]any
		}{*ev.ItemID, ev.Path, ev.Detail}
	}
	if got := byUser["capped"]; got.itemID != docxFileID || got.path != "/OfficeSaveDir/report.docx" ||
		got.detail["reason"] != "quota_exceeded" || got.detail["scope"] != "user" ||
		got.detail["requiredBytes"] != float64(docLen) || got.detail["availableBytes"] != float64(docLen-10) {
		t.Fatalf("unexpected capped office_save audit: %+v", got)
	}
	if got := byUser["pooler"]; got.itemID != xlsxFileID || got.path != "/OfficeSaveDir/sheet.xlsx" ||
		got.detail["reason"] != "quota_exceeded" || got.detail["scope"] != "organization_pool" ||
		got.detail["organizationName"] != "ChildOrg" || got.detail["requiredBytes"] != float64(xlsLen) ||
		got.detail["availableBytes"] != float64(xlsLen-20) {
		t.Fatalf("unexpected pooler office_save audit: %+v", got)
	}
	if got := byUser["heavy"]; got.itemID != xlsxFileID || got.path != "/OfficeSaveDir/sheet.xlsx" ||
		got.detail["reason"] != "quota_exceeded" || got.detail["scope"] != "organization_total" ||
		got.detail["organizationName"] != "RootOrg" || got.detail["requiredBytes"] != float64(xlsLen) ||
		got.detail["availableBytes"] != float64(xlsLen-35) {
		t.Fatalf("unexpected heavy office_save audit: %+v", got)
	}
}

func TestConcurrentTextAndOfficeSavesRespectQuotaAndLockOrdering(t *testing.T) {
	stores := startStores(t)
	clk := clock.NewFake(time.Date(2026, 11, 25, 16, 0, 0, 0, time.UTC))
	server := startService(t, stores.config, clk)
	admin := newBrowser(t, server)
	signInAsAdministrator(t, admin)

	call := func(b *browser, method, path string, body any, want int) []byte {
		t.Helper()
		status, data := b.do(method, "/api"+path, body)
		if status != want {
			t.Fatalf("%s %s: status=%d, want %d: %s", method, path, status, want, data)
		}
		return data
	}

	docxBytes := officeZip(t, false)
	docLen := int64(len(docxBytes))

	var org apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "RaceEditOrg", "quotaBytes": docLen * 2}, 201), &org)
	csvBody := fmt.Sprintf("username,display_name,password,organization_id\nracer,Race Editor,Pass12345!,%d\n", org.ID)
	call(admin, "POST", "/users/import", map[string]any{"csv": csvBody}, 201)

	var users []apiManagedUserQuota
	decode(t, call(admin, "GET", "/managed-users", nil, 200), &users)
	var racerID int64
	for _, u := range users {
		if u.Username == "racer" {
			racerID = u.ID
		}
	}
	// Exact quota for ONE docLen save.
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", racerID), map[string]any{"quotaBytes": docLen}, 200)

	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/tree", map[string]any{"name": "RaceEditDir"}, 201), &dir)
	call(admin, "POST", fmt.Sprintf("/tree/%d/grants", dir.ID), map[string]any{
		"principalKind": "organization",
		"principalId":   org.ID,
		"rights":        63,
		"scope":         "subtree",
	}, 201)

	// Admin uploads 4 docx files and 2 txt files so racer starts at 0 B used.
	racer := newBrowser(t, server)
	if status, body := racer.signIn("racer", "Pass12345!"); status != 200 {
		t.Fatalf("sign in racer: %d %+v", status, body)
	}
	saveURLs := make([]string, 4)
	for i := range saveURLs {
		fileID, _ := completeSingleUpload(t, server.URL, admin, dir.ID, fmt.Sprintf("doc-%d.docx", i), docxBytes, "")
		var permit struct {
			DocumentURL string `json:"documentUrl"`
			SaveURL     string `json:"saveUrl"`
		}
		decode(t, call(racer, "POST", fmt.Sprintf("/files/%d/office-edits", fileID), map[string]any{}, 201), &permit)
		res, err := http.Get(server.URL + permit.DocumentURL)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("deliver: %d", res.StatusCode)
		}
		saveURLs[i] = permit.SaveURL
	}
	txtFileID, txtV1 := completeSingleUpload(t, server.URL, admin, dir.ID, "race.txt", []byte("seed"), "")

	// Race 4 Office saves (each docLen) + 1 Text save (docLen) + concurrent membership/quota reads/writes on another org
	// to verify both atomicity (at most 1 write succeeds) and deadlock freedom across 725005 -> 725010!
	var otherOrg apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "OtherLockOrg", "quotaBytes": int64(1000)}, 201), &otherOrg)

	var (
		wg         sync.WaitGroup
		start      = make(chan struct{})
		succeeded  atomic.Int32
		refused    atomic.Int32
		unexpected atomic.Int32
	)
	for _, saveURL := range saveURLs {
		wg.Add(1)
		go func(url string) {
			defer wg.Done()
			<-start
			status, receipt, _ := submitOfficeSave(t, server.URL, racer, url, "writer", docxBytes)
			if status == 200 && receipt["Success"] == true {
				succeeded.Add(1)
			} else if status == 507 && receipt["Success"] == false {
				refused.Add(1)
			} else {
				unexpected.Add(1)
			}
		}(saveURL)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-start
		status, _ := racer.do("PUT", fmt.Sprintf("/api/tree/%d/text", txtFileID), map[string]any{
			"baseVersionId": txtV1,
			"content":       strings.Repeat("x", int(docLen)),
		})
		if status == 201 {
			succeeded.Add(1)
		} else if status == 507 {
			refused.Add(1)
		} else {
			unexpected.Add(1)
		}
	}()
	// Concurrent 725005 writer racing with 725005->725010 edit writers.
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-start
		for i := 0; i < 4; i++ {
			status, _ := admin.do("PATCH", fmt.Sprintf("/api/organizations/%d", otherOrg.ID), map[string]any{
				"name":       "OtherLockOrg",
				"quotaBytes": int64(1000 + i),
			})
			if status != 200 {
				unexpected.Add(1)
			}
		}
	}()

	close(start)
	wg.Wait()

	if unexpected.Load() != 0 {
		t.Fatalf("unexpected concurrent errors/statuses: %d", unexpected.Load())
	}
	if succeeded.Load() != 1 || refused.Load() != 4 {
		t.Fatalf("expected exactly 1 save succeeded and 4 refused with 507, got succeeded=%d refused=%d", succeeded.Load(), refused.Load())
	}
	decode(t, call(admin, "GET", "/managed-users", nil, 200), &users)
	for _, u := range users {
		if u.ID == racerID && u.UsedBytes != docLen {
			t.Fatalf("racer final usedBytes = %d, want exact quota %d", u.UsedBytes, docLen)
		}
	}
}
