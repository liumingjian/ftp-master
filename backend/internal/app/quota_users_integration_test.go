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

type apiManagedUserQuota struct {
	ID             int64  `json:"id"`
	Username       string `json:"username"`
	DisplayName    string `json:"displayName"`
	Status         string `json:"status"`
	OrganizationID int64  `json:"organizationId"`
	QuotaBytes     *int64 `json:"quotaBytes"`
	CommittedBytes int64  `json:"committedBytes"`
	ReservedBytes  int64  `json:"reservedBytes"`
	UsedBytes      int64  `json:"usedBytes"`
}

func TestUserQuotasCRUDPartitioningAndAudit(t *testing.T) {
	stores := startStores(t)
	clk := clock.NewFake(time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))
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

	// Create hierarchy:
	//   Default (id=1, unlimited)
	//   RootCap (100 MB)
	//     └─ MidUnlimited (unlimited)
	//         └─ DeepUnlimited (unlimited)
	var rootCap, midUnlimited, deepUnlimited apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "RootCap", "quotaBytes": 100 * mb}, 201), &rootCap)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "MidUnlimited", "parentId": rootCap.ID}, 201), &midUnlimited)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "DeepUnlimited", "parentId": midUnlimited.ID}, 201), &deepUnlimited)

	// Create active users via 4-column CSV import and pending Registration activation to verify defaults too.
	csvBody := fmt.Sprintf("username,display_name,password,organization_id\nalice,Alice,AlphaPass123!,%d\nbob,Bob,BetaPass123!,%d\n", deepUnlimited.ID, deepUnlimited.ID)
	call(admin, "POST", "/users/import", map[string]any{"csv": csvBody}, 201)

	anon := newBrowser(t, server)
	call(anon, "POST", "/registrations", map[string]any{
		"username":         "pending-user",
		"displayName":      "Pending User",
		"organizationHint": "DeepUnlimited",
		"password":         "PendingPass123!",
	}, 201)
	call(anon, "POST", "/registrations", map[string]any{
		"username":         "activated-user",
		"displayName":      "Activated User",
		"organizationHint": "Default",
		"password":         "ActivatedPass123!",
	}, 201)

	var regs []struct {
		ID       int64  `json:"id"`
		Username string `json:"username"`
	}
	decode(t, call(admin, "GET", "/registrations", nil, 200), &regs)
	var pendingID, activateID int64
	for _, r := range regs {
		if r.Username == "pending-user" {
			pendingID = r.ID
		}
		if r.Username == "activated-user" {
			activateID = r.ID
		}
	}
	call(admin, "POST", fmt.Sprintf("/registrations/%d/activate", activateID), map[string]any{"organizationId": 1}, 204)

	readUsers := func() map[string]apiManagedUserQuota {
		t.Helper()
		var list []apiManagedUserQuota
		decode(t, call(admin, "GET", "/managed-users", nil, 200), &list)
		byName := make(map[string]apiManagedUserQuota, len(list))
		for _, u := range list {
			byName[u.Username] = u
		}
		return byName
	}

	users := readUsers()
	alice := users["alice"]
	bob := users["bob"]
	activated := users["activated-user"]
	adminUser := users[initialAdministratorUsername]

	// Newly imported and activated users default to quotaBytes == nil.
	for _, u := range []apiManagedUserQuota{alice, bob, activated} {
		if u.QuotaBytes != nil {
			t.Fatalf("new user %s should default to unlimited quota, got %+v", u.Username, u)
		}
	}

	// 1. Admin sets User Quota on an Administrator inside unlimited Default org (50 MB).
	var updatedAdmin apiManagedUserQuota
	decode(t, call(admin, "PUT", fmt.Sprintf("/users/%d/quota", adminUser.ID), map[string]any{"quotaBytes": 50 * mb}, 200), &updatedAdmin)
	if updatedAdmin.QuotaBytes == nil || *updatedAdmin.QuotaBytes != 50*mb {
		t.Fatalf("updated admin = %+v", updatedAdmin)
	}
	// Clear Administrator's quota back to NULL (unlimited).
	decode(t, call(admin, "PUT", fmt.Sprintf("/users/%d/quota", adminUser.ID), map[string]any{"quotaBytes": nil}, 200), &updatedAdmin)
	if updatedAdmin.QuotaBytes != nil {
		t.Fatalf("cleared admin = %+v", updatedAdmin)
	}

	// 2. Setting User Quota on alice (60 MB) passes transparently through DeepUnlimited & MidUnlimited to RootCap (100 MB).
	var updatedAlice apiManagedUserQuota
	decode(t, call(admin, "PUT", fmt.Sprintf("/users/%d/quota", alice.ID), map[string]any{"quotaBytes": 60 * mb}, 200), &updatedAlice)
	if updatedAlice.QuotaBytes == nil || *updatedAlice.QuotaBytes != 60*mb {
		t.Fatalf("updated alice = %+v", updatedAlice)
	}

	// 3. Setting bob to 41 MB exceeds RootCap remaining 40 MB across uncapped intermediates -> 409.
	var errResp struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	decode(t, call(admin, "PUT", fmt.Sprintf("/users/%d/quota", bob.ID), map[string]any{"quotaBytes": 41 * mb}, 409), &errResp)
	if errResp.Code != "quota_conflict" {
		t.Fatalf("expected quota_conflict, got %+v", errResp)
	}

	// Exact fit 40 MB succeeds.
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", bob.ID), map[string]any{"quotaBytes": 40 * mb}, 200)

	// 4. Lowering RootCap below allocated descendant User Quotas (100 MB) is rejected (409).
	decode(t, call(admin, "PATCH", fmt.Sprintf("/organizations/%d", rootCap.ID), map[string]any{
		"name":       "RootCap",
		"quotaBytes": 99 * mb,
	}, 409), &errResp)
	if errResp.Code != "quota_conflict" {
		t.Fatalf("expected quota_conflict lowering org below user quotas, got %+v", errResp)
	}

	// 5. Zeroing bob (0 bytes, distinct from unlimited) frees 40 MB in RootCap; then clearing bob to NULL.
	var updatedBob apiManagedUserQuota
	decode(t, call(admin, "PUT", fmt.Sprintf("/users/%d/quota", bob.ID), map[string]any{"quotaBytes": 0}, 200), &updatedBob)
	if updatedBob.QuotaBytes == nil || *updatedBob.QuotaBytes != 0 {
		t.Fatalf("zeroed bob = %+v", updatedBob)
	}
	// Now lowering RootCap to 60 MB succeeds (matches alice's 60 MB + bob's 0).
	call(admin, "PATCH", fmt.Sprintf("/organizations/%d", rootCap.ID), map[string]any{
		"name":       "RootCap",
		"quotaBytes": 60 * mb,
	}, 200)
	// Clearing bob to unlimited (NULL) succeeds.
	decode(t, call(admin, "PUT", fmt.Sprintf("/users/%d/quota", bob.ID), map[string]any{"quotaBytes": nil}, 200), &updatedBob)
	if updatedBob.QuotaBytes != nil {
		t.Fatalf("cleared bob = %+v", updatedBob)
	}
	// Idempotent no-op (NULL -> NULL) succeeds and must NOT emit an extra quota_change audit event.
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", bob.ID), map[string]any{"quotaBytes": nil}, 200)

	// 6. Invalid inputs & authorization checks.
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", bob.ID), map[string]any{"quotaBytes": -1}, 400)
	call(admin, "PUT", "/users/999999/quota", map[string]any{"quotaBytes": 10 * mb}, 404)
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", pendingID), map[string]any{"quotaBytes": 10 * mb}, 409)

	// Non-Administrator is refused (403).
	aliceBrowser := newBrowser(t, server)
	if status, _ := aliceBrowser.signIn("alice", "AlphaPass123!"); status != 200 {
		t.Fatalf("alice sign-in: %d", status)
	}
	call(aliceBrowser, "PUT", fmt.Sprintf("/users/%d/quota", bob.ID), map[string]any{"quotaBytes": 5 * mb}, 403)
	call(aliceBrowser, "PUT", fmt.Sprintf("/users/%d/organization", bob.ID), map[string]any{"organizationId": 1, "updateQuota": true, "quotaBytes": nil}, 403)
	call(aliceBrowser, "GET", "/managed-users", nil, 403)

	// 7. Verify quota_change Audit Events under account category.
	// Expected user quota_change events (6):
	//   1) admin: nil -> 50 MB
	//   2) admin: 50 MB -> nil
	//   3) alice: nil -> 60 MB
	//   4) bob: nil -> 40 MB
	//   5) bob: 40 MB -> 0
	//   6) bob: 0 -> nil
	// Plus org quota_change events (2): RootCap create (100 MB) and RootCap update (100 -> 60 MB).
	var auditResp struct {
		Total  int `json:"total"`
		Events []struct {
			Action  string         `json:"action"`
			Outcome string         `json:"outcome"`
			Detail  map[string]any `json:"detail"`
		} `json:"events"`
	}
	decode(t, call(admin, "POST", "/audit/query", map[string]any{
		"from":   "2026-11-25T00:00:00Z",
		"to":     "2026-11-26T00:00:00Z",
		"action": "quota_change",
	}, 200), &auditResp)
	if auditResp.Total != 8 {
		raw, _ := json.Marshal(auditResp)
		t.Fatalf("quota_change total = %d, want 8: %s", auditResp.Total, raw)
	}
	userQuotaEvents := 0
	for _, ev := range auditResp.Events {
		if ev.Outcome != "success" {
			t.Fatalf("unexpected outcome: %+v", ev)
		}
		if ev.Detail["targetKind"] == "user" {
			userQuotaEvents++
		}
	}
	if userQuotaEvents != 6 {
		raw, _ := json.Marshal(auditResp)
		t.Fatalf("user quota_change events = %d, want 6: %s", userQuotaEvents, raw)
	}
	// Newest quota_change event should be bob: 0 -> nil.
	newest := auditResp.Events[0]
	if newest.Detail["targetKind"] != "user" ||
		newest.Detail["targetName"] != "bob" ||
		int64(newest.Detail["targetId"].(float64)) != bob.ID ||
		int64(newest.Detail["previousQuotaBytes"].(float64)) != 0 ||
		newest.Detail["newQuotaBytes"] != nil {
		t.Fatalf("unexpected newest quota_change detail: %+v", newest)
	}

	// Confirm all quota_change events appear in category = "account".
	var accountCat struct {
		Events []struct {
			Action string `json:"action"`
		} `json:"events"`
	}
	decode(t, call(admin, "POST", "/audit/query", map[string]any{
		"from":     "2026-11-25T00:00:00Z",
		"to":       "2026-11-26T00:00:00Z",
		"category": "account",
	}, 200), &accountCat)
	quotaInAccount := 0
	for _, ev := range accountCat.Events {
		if ev.Action == "quota_change" {
			quotaInAccount++
		}
	}
	if quotaInAccount != 8 {
		t.Fatalf("account category had %d quota_change events, want 8", quotaInAccount)
	}
}

func TestUserMovesAtomicQuotaTransferUsageRollupAndDeactivation(t *testing.T) {
	stores := startStores(t)
	clk := clock.NewFake(time.Date(2026, 11, 25, 11, 0, 0, 0, time.UTC))
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

	// Create SourceOrg (100 MB), TightDest (30 MB), and PeerDest (50 MB).
	var sourceOrg, tightDest, peerDest apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "SourceOrg", "quotaBytes": 100 * mb}, 201), &sourceOrg)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "TightDest", "quotaBytes": 30 * mb}, 201), &tightDest)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "PeerDest", "quotaBytes": 50 * mb}, 201), &peerDest)

	// Create alice in SourceOrg and charlie in TightDest via DB seed or CSV import.
	csvBody := fmt.Sprintf("username,display_name,password,organization_id\nalice-move,Alice Move,AlphaPass123!,%d\ncharlie-dest,Charlie Dest,CharliePass123!,%d\n", sourceOrg.ID, tightDest.ID)
	call(admin, "POST", "/users/import", map[string]any{"csv": csvBody}, 201)

	readUsers := func() map[string]apiManagedUserQuota {
		t.Helper()
		var list []apiManagedUserQuota
		decode(t, call(admin, "GET", "/managed-users", nil, 200), &list)
		m := make(map[string]apiManagedUserQuota, len(list))
		for _, u := range list {
			m[u.Username] = u
		}
		return m
	}
	readOrgs := func() map[int64]apiOrgQuota {
		t.Helper()
		var list []apiOrgQuota
		decode(t, call(admin, "GET", "/organizations", nil, 200), &list)
		m := make(map[int64]apiOrgQuota, len(list))
		for _, o := range list {
			m[o.ID] = o
		}
		return m
	}

	users := readUsers()
	alice := users["alice-move"]
	charlie := users["charlie-dest"]

	// Set alice quota = 50 MB in SourceOrg; charlie quota = 10 MB in TightDest (leaving TightDest 20 MB unallocated).
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", alice.ID), map[string]any{"quotaBytes": 50 * mb}, 200)
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", charlie.ID), map[string]any{"quotaBytes": 10 * mb}, 200)

	// Give alice access to a top-level folder and create committed + reserved storage usage.
	var docsDir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/tree", map[string]any{"name": "TransferDocs"}, 201), &docsDir)
	call(admin, "POST", fmt.Sprintf("/tree/%d/grants", docsDir.ID), map[string]any{
		"principalKind": "user",
		"principalId":   alice.ID,
		"rights":        63,
		"scope":         "subtree",
	}, 201)

	aliceBrowser := newBrowser(t, server)
	if status, _ := aliceBrowser.signIn("alice-move", "AlphaPass123!"); status != 200 {
		t.Fatalf("alice sign-in: %d", status)
	}

	// Upload a 4000-byte committed file + start a 1500-byte incomplete upload (reserved).
	payload := bytes.Repeat([]byte("x"), 4000)
	var up1 struct {
		ID string `json:"id"`
	}
	decode(t, call(aliceBrowser, "POST", "/uploads", map[string]any{
		"parentId": docsDir.ID,
		"name":     "report.txt",
		"size":     len(payload),
	}, 201), &up1)
	var urls []struct {
		URL string `json:"url"`
	}
	decode(t, call(aliceBrowser, "POST", "/uploads/"+up1.ID+"/parts", map[string]any{"numbers": []int{1}}, 200), &urls)
	req, _ := http.NewRequest("PUT", server.URL+urls[0].URL, bytes.NewReader(payload))
	req.AddCookie(aliceBrowser.cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("put part: %d", res.StatusCode)
	}
	var receipt struct {
		FileID int64 `json:"fileId"`
	}
	decode(t, call(aliceBrowser, "POST", "/uploads/"+up1.ID+"/complete", nil, 200), &receipt)

	// Start an active incomplete upload for 1500 reserved bytes.
	call(aliceBrowser, "POST", "/uploads", map[string]any{
		"parentId": docsDir.ID,
		"name":     "pending.bin",
		"size":     1500,
	}, 201)

	// Verify GET /managed-users shows alice's committed=4000, reserved=1500, used=5500, quota=50 MB.
	alice = readUsers()["alice-move"]
	if alice.CommittedBytes != 4000 || alice.ReservedBytes != 1500 || alice.UsedBytes != 5500 || alice.QuotaBytes == nil || *alice.QuotaBytes != 50*mb {
		t.Fatalf("alice usage/quota = %+v", alice)
	}

	// 1. Lowering alice's quota below current usage (2000 < 5500) succeeds without deleting files.
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", alice.ID), map[string]any{"quotaBytes": 2000}, 200)
	dlReq, _ := http.NewRequest("GET", server.URL+fmt.Sprintf("/api/tree/%d/download", receipt.FileID), nil)
	dlReq.AddCookie(aliceBrowser.cookie)
	dlRes, err := http.DefaultClient.Do(dlReq)
	if err != nil {
		t.Fatal(err)
	}
	dlBytes, _ := io.ReadAll(dlRes.Body)
	dlRes.Body.Close()
	if dlRes.StatusCode != 200 || !bytes.Equal(dlBytes, payload) {
		t.Fatalf("file download after quota downgrade: status=%d len=%d", dlRes.StatusCode, len(dlBytes))
	}

	// Restore alice quota to 50 MB for move tests.
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", alice.ID), map[string]any{"quotaBytes": 50 * mb}, 200)

	// 2. Moving alice into TightDest (remaining 20 MB) preserving 50 MB quota fails (409) and leaves org/quota unchanged.
	call(admin, "PUT", fmt.Sprintf("/users/%d/organization", alice.ID), map[string]any{"organizationId": tightDest.ID}, 409)
	alice = readUsers()["alice-move"]
	if alice.OrganizationID != sourceOrg.ID || alice.QuotaBytes == nil || *alice.QuotaBytes != 50*mb {
		t.Fatalf("after rejected move, alice = %+v, want unchanged in SourceOrg with 50 MB", alice)
	}

	// 3. Atomic move + quota adjustment (20 MB fits TightDest exactly) succeeds in one request!
	call(admin, "PUT", fmt.Sprintf("/users/%d/organization", alice.ID), map[string]any{
		"organizationId": tightDest.ID,
		"updateQuota":    true,
		"quotaBytes":     20 * mb,
	}, 204)

	alice = readUsers()["alice-move"]
	if alice.OrganizationID != tightDest.ID || alice.QuotaBytes == nil || *alice.QuotaBytes != 20*mb {
		t.Fatalf("after atomic move+quota, alice = %+v", alice)
	}
	// Historical usage immediately shifted from SourceOrg to TightDest!
	orgs := readOrgs()
	if orgs[sourceOrg.ID].UsedBytes != 0 || orgs[sourceOrg.ID].AllocatedBytes != 0 {
		t.Fatalf("SourceOrg after alice left = %+v, want 0 used & 0 allocated", orgs[sourceOrg.ID])
	}
	if orgs[tightDest.ID].UsedBytes != 5500 || orgs[tightDest.ID].AllocatedBytes != 30*mb || *orgs[tightDest.ID].UnallocatedBytes != 0 {
		t.Fatalf("TightDest after alice joined = %+v, want used=5500 allocated=30MB unallocated=0", orgs[tightDest.ID])
	}

	// Emptied SourceOrg can now be deleted cleanly!
	call(admin, "DELETE", fmt.Sprintf("/organizations/%d", sourceOrg.ID), nil, 204)

	// 4. Moving alice (20 MB) into PeerDest (50 MB remaining) WITHOUT updateQuota preserves 20 MB quota.
	call(admin, "PUT", fmt.Sprintf("/users/%d/organization", alice.ID), map[string]any{"organizationId": peerDest.ID}, 204)
	alice = readUsers()["alice-move"]
	if alice.OrganizationID != peerDest.ID || alice.QuotaBytes == nil || *alice.QuotaBytes != 20*mb {
		t.Fatalf("after org-only move to PeerDest, alice = %+v, want preserved 20 MB", alice)
	}
	orgs = readOrgs()
	if orgs[tightDest.ID].UsedBytes != 0 || orgs[tightDest.ID].AllocatedBytes != 10*mb {
		t.Fatalf("TightDest after alice moved to PeerDest = %+v", orgs[tightDest.ID])
	}
	if orgs[peerDest.ID].UsedBytes != 5500 || orgs[peerDest.ID].AllocatedBytes != 20*mb {
		t.Fatalf("PeerDest after alice moved in = %+v", orgs[peerDest.ID])
	}

	// 5. Atomic move back to TightDest clearing quota to NULL (unlimited) via updateQuota: true, quotaBytes: null.
	call(admin, "PUT", fmt.Sprintf("/users/%d/organization", alice.ID), map[string]any{
		"organizationId": tightDest.ID,
		"updateQuota":    true,
		"quotaBytes":     nil,
	}, 204)
	alice = readUsers()["alice-move"]
	if alice.OrganizationID != tightDest.ID || alice.QuotaBytes != nil {
		t.Fatalf("after atomic move+clear quota, alice = %+v, want quotaBytes=nil", alice)
	}

	// Give alice 20 MB again in TightDest (now TightDest allocated = 10 MB charlie + 20 MB alice = 30 MB, unallocated = 0).
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", alice.ID), map[string]any{"quotaBytes": 20 * mb}, 200)

	// 6. Deactivating alice keeps both her Storage Usage (5500) and User Quota (20 MB) unchanged.
	call(admin, "PATCH", fmt.Sprintf("/users/%d/status", alice.ID), map[string]any{"status": "deactivated"}, 204)
	alice = readUsers()["alice-move"]
	if alice.Status != "deactivated" || alice.UsedBytes != 5500 || alice.QuotaBytes == nil || *alice.QuotaBytes != 20*mb {
		t.Fatalf("deactivated alice = %+v, want intact usage=5500 quota=20MB", alice)
	}
	orgs = readOrgs()
	if orgs[tightDest.ID].UsedBytes != 5500 || orgs[tightDest.ID].AllocatedBytes != 30*mb || *orgs[tightDest.ID].UnallocatedBytes != 0 {
		t.Fatalf("TightDest with deactivated alice = %+v", orgs[tightDest.ID])
	}

	// Charlie cannot raise quota from 10 MB to 30 MB yet (blocked by deactivated alice's 20 MB).
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", charlie.ID), map[string]any{"quotaBytes": 30 * mb}, 409)

	// Admin zeroes deactivated alice's quota to reclaim 20 MB for active charlie!
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", alice.ID), map[string]any{"quotaBytes": 0}, 200)
	alice = readUsers()["alice-move"]
	if alice.Status != "deactivated" || alice.QuotaBytes == nil || *alice.QuotaBytes != 0 || alice.UsedBytes != 5500 {
		t.Fatalf("zeroed deactivated alice = %+v", alice)
	}
	orgs = readOrgs()
	if orgs[tightDest.ID].AllocatedBytes != 10*mb || *orgs[tightDest.ID].UnallocatedBytes != 20*mb {
		t.Fatalf("TightDest after reclaiming deactivated alice quota = %+v", orgs[tightDest.ID])
	}
	// Now charlie can claim the full 30 MB!
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", charlie.ID), map[string]any{"quotaBytes": 30 * mb}, 200)

	// Verify DB directly has expected audit events for atomic moves (both account_change and quota_change).
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stores.config.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var quotaChangeCount int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action = 'quota_change' AND detail->>'targetKind' = 'user'`).Scan(&quotaChangeCount); err != nil {
		t.Fatal(err)
	}
	// User quota changes:
	//   1) alice nil->50MB
	//   2) charlie nil->10MB
	//   3) alice 50MB->2000
	//   4) alice 2000->50MB
	//   5) atomic move alice 50MB->20MB
	//   6) atomic move alice 20MB->nil (note org-only move to PeerDest preserved 20MB -> no quota_change!)
	//   7) alice nil->20MB
	//   8) deactivated alice 20MB->0
	//   9) charlie 10MB->30MB
	if quotaChangeCount != 9 {
		t.Fatalf("user quota_change audit count = %d, want 9", quotaChangeCount)
	}
}
