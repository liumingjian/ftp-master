//go:build integration

package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
)

type apiOrgQuota struct {
	ID               int64  `json:"id"`
	Name             string `json:"name"`
	ParentID         *int64 `json:"parentId"`
	QuotaBytes       *int64 `json:"quotaBytes"`
	CommittedBytes   int64  `json:"committedBytes"`
	ReservedBytes    int64  `json:"reservedBytes"`
	UsedBytes        int64  `json:"usedBytes"`
	AllocatedBytes   int64  `json:"allocatedBytes"`
	UnallocatedBytes *int64 `json:"unallocatedBytes"`
}

func TestOrganizationQuotasHierarchyMovesAndAudit(t *testing.T) {
	stores := startStores(t)
	clk := clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC))
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

	const mb int64 = 1024 * 1024

	// 1. Negative quota rejected with 400.
	call(admin, "POST", "/organizations", map[string]any{"name": "Bad", "quotaBytes": -1}, 400)

	// 2. Child Organization can have a quota under unlimited parent (Default id=1).
	var childUnderUnlimited apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{
		"name":       "CappedUnderDefault",
		"parentId":   1,
		"quotaBytes": 50 * mb,
	}, 201), &childUnderUnlimited)
	if childUnderUnlimited.QuotaBytes == nil || *childUnderUnlimited.QuotaBytes != 50*mb {
		t.Fatalf("childUnderUnlimited = %+v", childUnderUnlimited)
	}

	// 3. Root capped org (100 MB) -> uncapped intermediate -> leaf capped (60 MB).
	var rootA, midA, leafA1, leafA2 apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{
		"name":       "RootA",
		"quotaBytes": 100 * mb,
	}, 201), &rootA)
	decode(t, call(admin, "POST", "/organizations", map[string]any{
		"name":     "MidA",
		"parentId": rootA.ID,
	}, 201), &midA)
	decode(t, call(admin, "POST", "/organizations", map[string]any{
		"name":       "LeafA1",
		"parentId":   midA.ID,
		"quotaBytes": 60 * mb,
	}, 201), &leafA1)

	// Exceeding RootA ceiling across uncapped MidA is rejected (409).
	call(admin, "POST", "/organizations", map[string]any{
		"name":       "TooBig",
		"parentId":   midA.ID,
		"quotaBytes": 41 * mb,
	}, 409)

	// Exact fit (40 MB) succeeds.
	decode(t, call(admin, "POST", "/organizations", map[string]any{
		"name":       "LeafA2",
		"parentId":   midA.ID,
		"quotaBytes": 40 * mb,
	}, 201), &leafA2)

	// 4. Lowering RootA below allocated descendants (100 MB) rejected (409).
	call(admin, "PATCH", fmt.Sprintf("/organizations/%d", rootA.ID), map[string]any{
		"name":       "RootA",
		"quotaBytes": 99 * mb,
	}, 409)

	// Zeroing LeafA2 (0 bytes, distinct from unlimited) succeeds and frees 40 MB in RootA.
	decode(t, call(admin, "PATCH", fmt.Sprintf("/organizations/%d", leafA2.ID), map[string]any{
		"name":       "LeafA2",
		"parentId":   midA.ID,
		"quotaBytes": 0,
	}, 200), &leafA2)
	if leafA2.QuotaBytes == nil || *leafA2.QuotaBytes != 0 {
		t.Fatalf("zeroed LeafA2 = %+v", leafA2)
	}

	// Clearing LeafA2 back to unlimited (NULL) succeeds.
	decode(t, call(admin, "PATCH", fmt.Sprintf("/organizations/%d", leafA2.ID), map[string]any{
		"name":       "LeafA2",
		"parentId":   midA.ID,
		"quotaBytes": nil,
	}, 200), &leafA2)
	if leafA2.QuotaBytes != nil {
		t.Fatalf("cleared LeafA2 = %+v", leafA2)
	}

	// 5. Move validation: create RootB (50 MB); moving MidA (allocated 60 MB) into RootB is rejected (409).
	var rootB apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{
		"name":       "RootB",
		"quotaBytes": 50 * mb,
	}, 201), &rootB)
	call(admin, "PATCH", fmt.Sprintf("/organizations/%d", midA.ID), map[string]any{
		"name":     "MidA",
		"parentId": rootB.ID,
	}, 409)

	// Raising RootB to 60 MB allows moving uncapped MidA (allocated 60 MB) under RootB.
	call(admin, "PATCH", fmt.Sprintf("/organizations/%d", rootB.ID), map[string]any{
		"name":       "RootB",
		"quotaBytes": 60 * mb,
	}, 200)
	call(admin, "PATCH", fmt.Sprintf("/organizations/%d", midA.ID), map[string]any{
		"name":     "MidA",
		"parentId": rootB.ID,
	}, 200)

	// Verify GET /organizations reflects live allocated & unallocated metrics.
	var orgs []apiOrgQuota
	decode(t, call(admin, "GET", "/organizations", nil, 200), &orgs)
	byID := map[int64]apiOrgQuota{}
	for _, o := range orgs {
		byID[o.ID] = o
	}
	if byID[rootA.ID].AllocatedBytes != 0 || byID[rootA.ID].UnallocatedBytes == nil || *byID[rootA.ID].UnallocatedBytes != 100*mb {
		t.Fatalf("RootA after MidA moved out = %+v", byID[rootA.ID])
	}
	if byID[rootB.ID].AllocatedBytes != 60*mb || byID[rootB.ID].UnallocatedBytes == nil || *byID[rootB.ID].UnallocatedBytes != 0 {
		t.Fatalf("RootB after MidA moved in = %+v", byID[rootB.ID])
	}

	// 6. Verify non-Administrator is refused (403) on quota & admin usage endpoints.
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stores.config.MigrationDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at)
		SELECT 'quota-regular','Regular',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1`)
	if err != nil {
		t.Fatal(err)
	}
	regular := newBrowser(t, server)
	if status, _ := regular.signIn("quota-regular", initialAdministratorPassword); status != 200 {
		t.Fatalf("regular sign-in: %d", status)
	}
	call(regular, "GET", "/organizations", nil, 403)
	call(regular, "POST", "/organizations", map[string]any{"name": "Blocked", "quotaBytes": 10 * mb}, 403)
	call(regular, "PATCH", fmt.Sprintf("/organizations/%d", rootA.ID), map[string]any{"name": "Blocked", "quotaBytes": 10 * mb}, 403)

	// 7. Verify quota_change Audit Events are recorded atomically under the `account` category.
	// Expected quota_change events (8):
	//   1) Create CappedUnderDefault (nil -> 50 MB)
	//   2) Create RootA (nil -> 100 MB)
	//   3) Create LeafA1 (nil -> 60 MB)
	//   4) Create LeafA2 (nil -> 40 MB)
	//   5) Update LeafA2 (40 MB -> 0)
	//   6) Update LeafA2 (0 -> nil)
	//   7) Create RootB (nil -> 50 MB)
	//   8) Update RootB (50 MB -> 60 MB)
	// Note: Creating MidA (nil), moving MidA (nil -> nil), and all 409 rejections must NOT emit quota_change.
	var auditResp struct {
		Total  int `json:"total"`
		Events []struct {
			Action  string         `json:"action"`
			Outcome string         `json:"outcome"`
			Detail  map[string]any `json:"detail"`
		} `json:"events"`
	}
	decode(t, call(admin, "POST", "/audit/query", map[string]any{
		"from":   "2026-11-19T00:00:00Z",
		"to":     "2026-11-20T00:00:00Z",
		"action": "quota_change",
	}, 200), &auditResp)
	if auditResp.Total != 8 || len(auditResp.Events) != 8 {
		raw, _ := json.Marshal(auditResp)
		t.Fatalf("quota_change count = %d, want 8: %s", auditResp.Total, raw)
	}

	// Verify category = "account" includes all quota_change events alongside account_change events.
	var catResp struct {
		Total  int `json:"total"`
		Events []struct {
			Action string `json:"action"`
		} `json:"events"`
	}
	decode(t, call(admin, "POST", "/audit/query", map[string]any{
		"from":     "2026-11-19T00:00:00Z",
		"to":       "2026-11-20T00:00:00Z",
		"category": "account",
	}, 200), &catResp)
	quotaInAccount := 0
	for _, ev := range catResp.Events {
		if ev.Action == "quota_change" {
			quotaInAccount++
		}
	}
	if quotaInAccount != 8 {
		t.Fatalf("account category contained %d quota_change events, want 8 (total=%d)", quotaInAccount, catResp.Total)
	}

	// Check newest quota_change detail (RootB 50 MB -> 60 MB).
	newest := auditResp.Events[0]
	if newest.Outcome != "success" ||
		newest.Detail["targetKind"] != "organization" ||
		newest.Detail["targetName"] != "RootB" ||
		int64(newest.Detail["previousQuotaBytes"].(float64)) != 50*mb ||
		int64(newest.Detail["newQuotaBytes"].(float64)) != 60*mb {
		t.Fatalf("unexpected newest quota_change detail: %+v", newest)
	}
}

func TestLiveOrganizationStorageUsageRollupAndDowngradeBelowUsage(t *testing.T) {
	stores := startStores(t)
	clk := clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC))
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

	const mb int64 = 1024 * 1024

	// Create ParentOrg (100 MB) -> ChildOrg (50 MB).
	var parentOrg, childOrg apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "ParentUsage", "quotaBytes": 100 * mb}, 201), &parentOrg)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "ChildUsage", "parentId": parentOrg.ID, "quotaBytes": 50 * mb}, 201), &childOrg)

	// Create active user alice inside ChildOrg.
	ctx := context.Background()
	migConn, err := pgx.Connect(ctx, stores.config.MigrationDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer migConn.Close(ctx)
	var aliceID int64
	if err := migConn.QueryRow(ctx, `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at,organization_id)
		SELECT 'alice-usage','Alice',password_hash,false,'active',created_at,$1 FROM users WHERE is_administrator LIMIT 1 RETURNING id`, childOrg.ID).Scan(&aliceID); err != nil {
		t.Fatal(err)
	}

	// Verify application role can update users.quota_bytes (migration 00029 grant contract).
	appConn, err := pgx.Connect(ctx, stores.config.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer appConn.Close(ctx)
	if _, err := appConn.Exec(ctx, `UPDATE users SET quota_bytes = $1 WHERE id = $2`, 10*mb, aliceID); err != nil {
		t.Fatalf("ftp_master_app failed to update users.quota_bytes: %v", err)
	}
	if _, err := appConn.Exec(ctx, `UPDATE users SET quota_bytes = NULL WHERE id = $1`, aliceID); err != nil {
		t.Fatalf("ftp_master_app failed to clear users.quota_bytes: %v", err)
	}

	// Create top-level directory Docs and grant alice full control (63).
	var docsDir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/tree", map[string]any{"name": "Docs"}, 201), &docsDir)
	call(admin, "POST", fmt.Sprintf("/tree/%d/grants", docsDir.ID), map[string]any{
		"principalKind": "user",
		"principalId":   aliceID,
		"rights":        63,
		"scope":         "subtree",
	}, 201)

	alice := newBrowser(t, server)
	if status, _ := alice.signIn("alice-usage", initialAdministratorPassword); status != 200 {
		t.Fatalf("alice sign-in: %d", status)
	}

	readOrgs := func() map[int64]apiOrgQuota {
		t.Helper()
		var orgs []apiOrgQuota
		decode(t, call(admin, "GET", "/organizations", nil, 200), &orgs)
		m := make(map[int64]apiOrgQuota, len(orgs))
		for _, o := range orgs {
			m[o.ID] = o
		}
		return m
	}

	// 1. Initiate an incomplete upload of 2000 bytes -> counted as reservedBytes across ChildOrg and ParentOrg.
	contentV1 := bytes.Repeat([]byte("a"), 2000)
	var upload struct {
		ID       string `json:"id"`
		PartSize int64  `json:"partSize"`
	}
	decode(t, call(alice, "POST", "/uploads", map[string]any{
		"parentId": docsDir.ID,
		"name":     "notes.txt",
		"size":     len(contentV1),
	}, 201), &upload)

	orgs := readOrgs()
	for _, oid := range []int64{childOrg.ID, parentOrg.ID} {
		o := orgs[oid]
		if o.CommittedBytes != 0 || o.ReservedBytes != 2000 || o.UsedBytes != 2000 {
			t.Fatalf("org %d during active upload = %+v, want (0, 2000, 2000)", oid, o)
		}
	}

	// 2. Upload part and complete -> reserved converts cleanly to committed with zero double-counting.
	var urls []struct {
		Number int    `json:"number"`
		URL    string `json:"url"`
	}
	decode(t, call(alice, "POST", "/uploads/"+upload.ID+"/parts", map[string]any{"numbers": []int{1}}, 200), &urls)
	req, _ := http.NewRequest("PUT", server.URL+urls[0].URL, bytes.NewReader(contentV1))
	req.AddCookie(alice.cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("part upload: %d", res.StatusCode)
	}
	var receipt struct {
		FileID    int64 `json:"fileId"`
		VersionID int64 `json:"versionId"`
	}
	decode(t, call(alice, "POST", "/uploads/"+upload.ID+"/complete", nil, 200), &receipt)

	orgs = readOrgs()
	for _, oid := range []int64{childOrg.ID, parentOrg.ID} {
		o := orgs[oid]
		if o.CommittedBytes != 2000 || o.ReservedBytes != 0 || o.UsedBytes != 2000 {
			t.Fatalf("org %d after complete = %+v, want (2000, 0, 2000)", oid, o)
		}
	}

	// 3. Save a second text version (3500 bytes) -> both retained versions count (5500 bytes).
	contentV2 := string(bytes.Repeat([]byte("b"), 3500))
	call(alice, "PUT", fmt.Sprintf("/tree/%d/text", receipt.FileID), map[string]any{
		"baseVersionId": receipt.VersionID,
		"content":       contentV2,
	}, 201)

	orgs = readOrgs()
	for _, oid := range []int64{childOrg.ID, parentOrg.ID} {
		if orgs[oid].CommittedBytes != 5500 || orgs[oid].UsedBytes != 5500 {
			t.Fatalf("org %d after text save = %+v, want committed=5500", oid, orgs[oid])
		}
	}

	// 4. Restore v1 -> reuses immutable object_key at ZERO extra bytes (stays 5500).
	call(alice, "POST", fmt.Sprintf("/tree/%d/versions/%d/restore", receipt.FileID, receipt.VersionID), nil, 201)
	orgs = readOrgs()
	if orgs[childOrg.ID].CommittedBytes != 5500 || orgs[parentOrg.ID].CommittedBytes != 5500 {
		t.Fatalf("after version restore, child=%+v parent=%+v, want 5500", orgs[childOrg.ID], orgs[parentOrg.ID])
	}

	// 5. Soft-delete into Recycle Bin -> bytes remain counted (5500).
	call(alice, "DELETE", fmt.Sprintf("/tree/%d", receipt.FileID), nil, 204)
	orgs = readOrgs()
	if orgs[childOrg.ID].CommittedBytes != 5500 || orgs[parentOrg.ID].CommittedBytes != 5500 {
		t.Fatalf("in recycle bin, child=%+v parent=%+v, want 5500", orgs[childOrg.ID], orgs[parentOrg.ID])
	}

	// 6. Lower ChildOrg quota to 1000 bytes (below current actual usage 5500) -> succeeds without deleting files.
	decode(t, call(admin, "PATCH", fmt.Sprintf("/organizations/%d", childOrg.ID), map[string]any{
		"name":       "ChildUsage",
		"parentId":   parentOrg.ID,
		"quotaBytes": 1000,
	}, 200), &childOrg)
	if childOrg.QuotaBytes == nil || *childOrg.QuotaBytes != 1000 || childOrg.UsedBytes != 5500 {
		t.Fatalf("downgraded childOrg = %+v", childOrg)
	}

	// 7. File is still intact in Recycle Bin, restorable, and readable; moving alice shifts historical usage live.
	call(alice, "POST", fmt.Sprintf("/tree/%d/restore", receipt.FileID), map[string]any{}, 204)
	dlReq, _ := http.NewRequest("GET", server.URL+fmt.Sprintf("/api/tree/%d/download", receipt.FileID), nil)
	dlReq.AddCookie(alice.cookie)
	dlRes, err := http.DefaultClient.Do(dlReq)
	if err != nil {
		t.Fatal(err)
	}
	dlBytes, _ := io.ReadAll(dlRes.Body)
	dlRes.Body.Close()
	if dlRes.StatusCode != 200 || !bytes.Equal(dlBytes, contentV1) {
		t.Fatalf("download restored file: status=%d len=%d", dlRes.StatusCode, len(dlBytes))
	}
	var otherOrg apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "OtherUsage"}, 201), &otherOrg)
	call(admin, "PUT", fmt.Sprintf("/users/%d/organization", aliceID), map[string]any{"organizationId": otherOrg.ID}, 204)
	orgs = readOrgs()
	if orgs[childOrg.ID].UsedBytes != 0 || orgs[parentOrg.ID].UsedBytes != 0 || orgs[otherOrg.ID].UsedBytes != 5500 {
		t.Fatalf("after moving alice: child=%+v parent=%+v other=%+v", orgs[childOrg.ID], orgs[parentOrg.ID], orgs[otherOrg.ID])
	}
	call(alice, "DELETE", fmt.Sprintf("/tree/%d", receipt.FileID), nil, 204)
	call(admin, "DELETE", fmt.Sprintf("/tree/%d/purge", receipt.FileID), nil, 204)

	orgs = readOrgs()
	if orgs[otherOrg.ID].UsedBytes != 0 {
		t.Fatalf("after purge, other=%+v, want 0", orgs[otherOrg.ID])
	}
}

