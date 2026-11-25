//go:build integration

package app_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/liumingjian/ftp-master/backend/internal/clock"
)

type apiConstrainingOrg struct {
	Name                     string `json:"name"`
	QuotaBytes               int64  `json:"quotaBytes"`
	UsedBytes                int64  `json:"usedBytes"`
	AllocatedBytes           int64  `json:"allocatedBytes"`
	UnallocatedPoolBytes     int64  `json:"unallocatedPoolBytes"`
	UnallocatedPoolUsedBytes int64  `json:"unallocatedPoolUsedBytes"`
	RemainingBytes           int64  `json:"remainingBytes"`
	ConstraintKind           string `json:"constraintKind"`
}

type apiPendingUpload struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Size      int64     `json:"size"`
	ParentID  int64     `json:"parentId"`
	CreatedAt time.Time `json:"createdAt"`
	State     string    `json:"state"`
}

type apiPendingBatch struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	FileCount      int       `json:"fileCount"`
	ReservedBytes  int64     `json:"reservedBytes"`
	CommittedBytes int64     `json:"committedBytes"`
	TotalBytes     int64     `json:"totalBytes"`
	ParentID       int64     `json:"parentId"`
	CreatedAt      time.Time `json:"createdAt"`
}

type apiSelfStorage struct {
	CommittedBytes           int64               `json:"committedBytes"`
	ReservedBytes            int64               `json:"reservedBytes"`
	UsedBytes                int64               `json:"usedBytes"`
	QuotaBytes               *int64              `json:"quotaBytes"`
	AvailableBytes           *int64              `json:"availableBytes"`
	EffectiveLimitBytes      *int64              `json:"effectiveLimitBytes"`
	EffectiveUsedBytes       int64               `json:"effectiveUsedBytes"`
	EffectiveScope           *string             `json:"effectiveScope"`
	ConstrainingOrganization *apiConstrainingOrg `json:"constrainingOrganization"`
	PendingUploads           []apiPendingUpload  `json:"pendingUploads"`
	PendingBatches           []apiPendingBatch   `json:"pendingBatches"`
}

func TestMeStorageAuthPrivacyAndQuotaScopes(t *testing.T) {
	stores := startStores(t)
	clk := clock.NewFake(time.Date(2026, 11, 25, 13, 0, 0, 0, time.UTC))
	server := startService(t, stores.config, clk)

	// 1. Unauthenticated access must be rejected with 401.
	anon := newBrowser(t, server)
	if status, _ := anon.do("GET", "/api/me/storage", nil); status != 401 {
		t.Fatalf("unauthenticated GET /api/me/storage: status=%d, want 401", status)
	}

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

	// Build isolated org hierarchy with distinctive sentinel names:
	//   SecretRootOrg (quota 10000)
	//     ├─ SecretMidOrg (uncapped)
	//     │    ├─ alice-capped (User Quota 4000)
	//     │    └─ bob-uncapped (uncapped -> shares SecretRootOrg pool = 10000 - 4000 - 3000 = 3000)
	//     └─ SecretSiblingOrg (quota 3000)
	//          └─ carol-sibling (User Quota 2000)
	//   SecretCousinOrg (quota 5000)
	//   UnlimitedOnlyOrg (uncapped)
	//     └─ dave-unlimited (uncapped)
	var rootOrg, midOrg, siblingOrg, cousinOrg, unlimitedOrg apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "SecretRootOrg", "quotaBytes": 10000}, 201), &rootOrg)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "SecretMidOrg", "parentId": rootOrg.ID}, 201), &midOrg)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "SecretSiblingOrg", "parentId": rootOrg.ID, "quotaBytes": 3000}, 201), &siblingOrg)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "SecretCousinOrg", "quotaBytes": 5000}, 201), &cousinOrg)
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "UnlimitedOnlyOrg"}, 201), &unlimitedOrg)

	csvBody := fmt.Sprintf(
		"username,display_name,password,organization_id\n"+
			"alice-capped,Alice Sentinel,Pass12345!,%d\n"+
			"bob-uncapped,Bob Sentinel,Pass12345!,%d\n"+
			"carol-sibling,Carol Sentinel,Pass12345!,%d\n"+
			"dave-unlimited,Dave Sentinel,Pass12345!,%d\n",
		midOrg.ID, midOrg.ID, siblingOrg.ID, unlimitedOrg.ID,
	)
	call(admin, "POST", "/users/import", map[string]any{"csv": csvBody}, 201)

	var managed []apiManagedUserQuota
	decode(t, call(admin, "GET", "/managed-users", nil, 200), &managed)
	userIDs := map[string]int64{}
	for _, u := range managed {
		userIDs[u.Username] = u.ID
	}

	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["alice-capped"]), map[string]any{"quotaBytes": 4000}, 200)
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["carol-sibling"]), map[string]any{"quotaBytes": 2000}, 200)

	// Shared top-level folder granting all rights to all created orgs.
	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/tree", map[string]any{"name": "SharedStorageDir"}, 201), &dir)
	for _, orgID := range []int64{rootOrg.ID, unlimitedOrg.ID} {
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
		call(b, "POST", "/session", map[string]any{"username": username, "password": "Pass12345!"}, 200)
		return b
	}

	alice := signInUser("alice-capped")
	bob := signInUser("bob-uncapped")
	carol := signInUser("carol-sibling")
	dave := signInUser("dave-unlimited")

	// Non-admin still cannot read /organizations or /managed-users, but CAN read /me/storage.
	call(alice, "GET", "/organizations", nil, 403)
	call(alice, "GET", "/managed-users", nil, 403)

	// Create distinct committed files and pending uploads/batches across users.
	completeSingleUpload(t, server.URL, alice, dir.ID, "alice-done.bin", make([]byte, 1000), "")
	call(alice, "POST", "/uploads", map[string]any{"parentId": dir.ID, "name": "alice-pending-secret.bin", "size": 500}, 201)
	call(alice, "POST", "/upload-batches", map[string]any{
		"parentId": dir.ID,
		"name":     "AlicePendingBatch",
		"files":    []map[string]any{{"path": "a1.bin", "size": 300}},
	}, 201)

	completeSingleUpload(t, server.URL, bob, dir.ID, "bob-done.bin", make([]byte, 700), "")
	call(bob, "POST", "/uploads", map[string]any{"parentId": dir.ID, "name": "bob-pending-secret.bin", "size": 400}, 201)

	completeSingleUpload(t, server.URL, carol, dir.ID, "carol-done.bin", make([]byte, 900), "")
	call(carol, "POST", "/uploads", map[string]any{"parentId": dir.ID, "name": "carol-pending-secret.bin", "size": 200}, 201)

	completeSingleUpload(t, server.URL, dave, dir.ID, "dave-done.bin", make([]byte, 1234), "")

	// Strict schema & privacy check helper: verifies exact JSON keys and zero leaked sentinels.
	assertStrictSchema := func(raw []byte, forbidden []string) apiSelfStorage {
		t.Helper()
		var obj map[string]any
		if err := json.Unmarshal(raw, &obj); err != nil {
			t.Fatalf("unmarshal raw json: %v", err)
		}
		allowedTop := map[string]bool{
			"committedBytes": true, "reservedBytes": true, "usedBytes": true,
			"quotaBytes": true, "availableBytes": true, "effectiveLimitBytes": true,
			"effectiveUsedBytes": true, "effectiveScope": true, "constrainingOrganization": true,
			"pendingUploads": true, "pendingBatches": true,
		}
		for k := range obj {
			if !allowedTop[k] {
				t.Fatalf("unexpected top-level key %q in /me/storage payload: %s", k, raw)
			}
		}
		if orgVal, ok := obj["constrainingOrganization"].(map[string]any); ok {
			allowedOrg := map[string]bool{
				"name": true, "quotaBytes": true, "usedBytes": true,
				"allocatedBytes": true, "unallocatedPoolBytes": true,
				"unallocatedPoolUsedBytes": true, "remainingBytes": true,
				"constraintKind": true,
			}
			for k := range orgVal {
				if !allowedOrg[k] {
					t.Fatalf("unexpected constrainingOrganization key %q: %s", k, raw)
				}
			}
		}
		rawStr := string(raw)
		for _, secret := range forbidden {
			if strings.Contains(rawStr, secret) {
				t.Fatalf("privacy leak: /me/storage response contained forbidden substring %q: %s", secret, rawStr)
			}
		}
		var out apiSelfStorage
		decode(t, raw, &out)
		return out
	}

	// Verify Alice (capped 4000 inside SecretMidOrg -> constrained by SecretRootOrg total):
	//   Alice: committed=1000, reserved=500+300=800, used=1800, avail=2200.
	//   SecretRootOrg: quota=10000, allocated=4000(alice)+3000(SecretSiblingOrg)=7000, pool=3000,
	//     poolUsed=700+400(bob)=1100, totalUsed=1800(alice)+1100(bob)+1100(carol)=4000, totalRemaining=6000.
	aliceRaw := call(alice, "GET", "/me/storage", nil, 200)
	aliceStorage := assertStrictSchema(aliceRaw, []string{
		"bob-uncapped", "Bob Sentinel", "bob-pending-secret.bin",
		"carol-sibling", "Carol Sentinel", "carol-pending-secret.bin",
		"dave-unlimited", "Dave Sentinel", "admin",
		"SecretMidOrg", "SecretSiblingOrg", "SecretCousinOrg", "UnlimitedOnlyOrg",
	})
	if aliceStorage.CommittedBytes != 1000 || aliceStorage.ReservedBytes != 800 || aliceStorage.UsedBytes != 1800 {
		t.Fatalf("alice usage = %+v", aliceStorage)
	}
	if aliceStorage.QuotaBytes == nil || *aliceStorage.QuotaBytes != 4000 ||
		aliceStorage.AvailableBytes == nil || *aliceStorage.AvailableBytes != 2200 ||
		aliceStorage.EffectiveLimitBytes == nil || *aliceStorage.EffectiveLimitBytes != 4000 ||
		aliceStorage.EffectiveUsedBytes != 1800 ||
		aliceStorage.EffectiveScope == nil || *aliceStorage.EffectiveScope != "user" {
		t.Fatalf("alice quota summary = %+v", aliceStorage)
	}
	if aliceStorage.ConstrainingOrganization == nil ||
		aliceStorage.ConstrainingOrganization.Name != "SecretRootOrg" ||
		aliceStorage.ConstrainingOrganization.QuotaBytes != 10000 ||
		aliceStorage.ConstrainingOrganization.UsedBytes != 4000 ||
		aliceStorage.ConstrainingOrganization.AllocatedBytes != 7000 ||
		aliceStorage.ConstrainingOrganization.UnallocatedPoolBytes != 3000 ||
		aliceStorage.ConstrainingOrganization.UnallocatedPoolUsedBytes != 1100 ||
		aliceStorage.ConstrainingOrganization.RemainingBytes != 6000 ||
		aliceStorage.ConstrainingOrganization.ConstraintKind != "organization_total" {
		t.Fatalf("alice constraining org = %+v", aliceStorage.ConstrainingOrganization)
	}
	if len(aliceStorage.PendingUploads) != 1 || aliceStorage.PendingUploads[0].Name != "alice-pending-secret.bin" {
		t.Fatalf("alice pendingUploads = %+v", aliceStorage.PendingUploads)
	}
	if len(aliceStorage.PendingBatches) != 1 || aliceStorage.PendingBatches[0].Name != "AlicePendingBatch" {
		t.Fatalf("alice pendingBatches = %+v", aliceStorage.PendingBatches)
	}

	// Verify Bob (uncapped inside SecretMidOrg -> constrained by SecretRootOrg unallocated pool = 3000, poolUsed = 1100, avail = 1900):
	bobRaw := call(bob, "GET", "/me/storage", nil, 200)
	bobStorage := assertStrictSchema(bobRaw, []string{
		"alice-capped", "Alice Sentinel", "alice-pending-secret.bin", "AlicePendingBatch",
		"carol-sibling", "Carol Sentinel", "carol-pending-secret.bin",
		"dave-unlimited", "Dave Sentinel",
		"SecretMidOrg", "SecretSiblingOrg", "SecretCousinOrg", "UnlimitedOnlyOrg",
	})
	if bobStorage.CommittedBytes != 700 || bobStorage.ReservedBytes != 400 || bobStorage.UsedBytes != 1100 {
		t.Fatalf("bob usage = %+v", bobStorage)
	}
	if bobStorage.QuotaBytes != nil ||
		bobStorage.AvailableBytes == nil || *bobStorage.AvailableBytes != 1900 ||
		bobStorage.EffectiveLimitBytes == nil || *bobStorage.EffectiveLimitBytes != 3000 ||
		bobStorage.EffectiveUsedBytes != 1100 ||
		bobStorage.EffectiveScope == nil || *bobStorage.EffectiveScope != "organization_pool" {
		t.Fatalf("bob effective summary = %+v", bobStorage)
	}
	if bobStorage.ConstrainingOrganization == nil ||
		bobStorage.ConstrainingOrganization.Name != "SecretRootOrg" ||
		bobStorage.ConstrainingOrganization.ConstraintKind != "organization_pool" ||
		bobStorage.ConstrainingOrganization.RemainingBytes != 1900 {
		t.Fatalf("bob constraining org = %+v", bobStorage.ConstrainingOrganization)
	}
	if len(bobStorage.PendingUploads) != 1 || bobStorage.PendingUploads[0].Name != "bob-pending-secret.bin" || len(bobStorage.PendingBatches) != 0 {
		t.Fatalf("bob pending lists = %+v / %+v", bobStorage.PendingUploads, bobStorage.PendingBatches)
	}

	// Verify Dave (completely unlimited):
	daveRaw := call(dave, "GET", "/me/storage", nil, 200)
	daveStorage := assertStrictSchema(daveRaw, []string{
		"alice-capped", "bob-uncapped", "carol-sibling",
		"SecretRootOrg", "SecretMidOrg", "SecretSiblingOrg", "SecretCousinOrg", "UnlimitedOnlyOrg",
	})
	if daveStorage.CommittedBytes != 1234 || daveStorage.ReservedBytes != 0 || daveStorage.UsedBytes != 1234 ||
		daveStorage.QuotaBytes != nil || daveStorage.AvailableBytes != nil ||
		daveStorage.EffectiveLimitBytes != nil || daveStorage.EffectiveScope != nil ||
		daveStorage.ConstrainingOrganization != nil ||
		len(daveStorage.PendingUploads) != 0 || len(daveStorage.PendingBatches) != 0 {
		t.Fatalf("dave unlimited summary = %+v", daveStorage)
	}

	// Verify zero-byte User Quota renders zero ceiling and zero headroom.
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", userIDs["dave-unlimited"]), map[string]any{"quotaBytes": 0}, 200)
	var daveZero apiSelfStorage
	decode(t, call(dave, "GET", "/me/storage", nil, 200), &daveZero)
	if daveZero.QuotaBytes == nil || *daveZero.QuotaBytes != 0 ||
		daveZero.AvailableBytes == nil || *daveZero.AvailableBytes != 0 ||
		daveZero.EffectiveLimitBytes == nil || *daveZero.EffectiveLimitBytes != 0 ||
		daveZero.EffectiveUsedBytes != 1234 ||
		daveZero.EffectiveScope == nil || *daveZero.EffectiveScope != "user" {
		t.Fatalf("dave zero-quota summary = %+v", daveZero)
	}

	// Verify Administrator can also query their own /me/storage.
	var adminStorage apiSelfStorage
	decode(t, call(admin, "GET", "/me/storage", nil, 200), &adminStorage)
	if adminStorage.PendingUploads == nil || adminStorage.PendingBatches == nil {
		t.Fatalf("admin storage lists should be empty slices, not nil: %+v", adminStorage)
	}
}

func TestMeStoragePendingUploadsBatchesCancelAndRetention(t *testing.T) {
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

	var org apiOrgQuota
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "SelfServiceOrg", "quotaBytes": 10000}, 201), &org)
	csvBody := fmt.Sprintf("username,display_name,password,organization_id\nself-user,Self User,Pass12345!,%d\n", org.ID)
	call(admin, "POST", "/users/import", map[string]any{"csv": csvBody}, 201)

	var managed []apiManagedUserQuota
	decode(t, call(admin, "GET", "/managed-users", nil, 200), &managed)
	var selfID int64
	for _, u := range managed {
		if u.Username == "self-user" {
			selfID = u.ID
		}
	}
	call(admin, "PUT", fmt.Sprintf("/users/%d/quota", selfID), map[string]any{"quotaBytes": 5000}, 200)

	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/tree", map[string]any{"name": "SelfDir"}, 201), &dir)
	call(admin, "POST", fmt.Sprintf("/tree/%d/grants", dir.ID), map[string]any{
		"principalKind": "organization",
		"principalId":   org.ID,
		"rights":        63,
		"scope":         "subtree",
	}, 201)

	user := newBrowser(t, server)
	call(user, "POST", "/session", map[string]any{"username": "self-user", "password": "Pass12345!"}, 200)

	getStorage := func() apiSelfStorage {
		t.Helper()
		var out apiSelfStorage
		decode(t, call(user, "GET", "/me/storage", nil, 200), &out)
		return out
	}

	// 1. Completed single-file upload counts in committedBytes and is excluded from pendingUploads.
	fileID, ver1 := completeSingleUpload(t, server.URL, user, dir.ID, "report.bin", make([]byte, 600), "")
	// Overwrite with new version (400 B) and restore ver1 -> deduplicated committedBytes = 600 + 400 = 1000 B.
	completeSingleUpload(t, server.URL, user, dir.ID, "report.bin", make([]byte, 400), "new_version")
	call(user, "POST", fmt.Sprintf("/tree/%d/versions/%d/restore", fileID, ver1), nil, 201)

	s := getStorage()
	if s.CommittedBytes != 1000 || s.ReservedBytes != 0 || *s.AvailableBytes != 4000 || len(s.PendingUploads) != 0 {
		t.Fatalf("after version restore: %+v", s)
	}

	// Soft-delete retains committedBytes until purged; Administrator purge immediately frees bytes.
	call(user, "DELETE", fmt.Sprintf("/tree/%d", fileID), nil, 204)
	s = getStorage()
	if s.CommittedBytes != 1000 || *s.AvailableBytes != 4000 {
		t.Fatalf("after soft delete: %+v", s)
	}
	call(admin, "DELETE", fmt.Sprintf("/tree/%d/purge", fileID), nil, 204)
	s = getStorage()
	if s.CommittedBytes != 0 || *s.AvailableBytes != 5000 {
		t.Fatalf("after purge: %+v", s)
	}

	// 2. Initiate single-file upload -> listed in pendingUploads and counted in reservedBytes.
	var pendingSess struct {
		ID string `json:"id"`
	}
	decode(t, call(user, "POST", "/uploads", map[string]any{"parentId": dir.ID, "name": "stuck.bin", "size": 900}, 201), &pendingSess)
	s = getStorage()
	if s.ReservedBytes != 900 || *s.AvailableBytes != 4100 || len(s.PendingUploads) != 1 ||
		s.PendingUploads[0].ID != pendingSess.ID || s.PendingUploads[0].Name != "stuck.bin" ||
		s.PendingUploads[0].Size != 900 || s.PendingUploads[0].ParentID != dir.ID ||
		s.PendingUploads[0].State != "uploading" {
		t.Fatalf("after initiating single upload: %+v", s)
	}

	// 3. Initiate 2-file folder batch -> listed in pendingBatches (NOT pendingUploads).
	var batchSessions []struct {
		ID        string `json:"id"`
		PartSize  int64  `json:"partSize"`
		PartCount int    `json:"partCount"`
		BatchID   string `json:"batchId"`
	}
	decode(t, call(user, "POST", "/upload-batches", map[string]any{
		"parentId": dir.ID,
		"name":     "PartialFolder",
		"files": []map[string]any{
			{"path": "first.bin", "size": 500},
			{"path": "sub/second.bin", "size": 800},
		},
	}, 201), &batchSessions)
	batchID := batchSessions[0].BatchID

	s = getStorage()
	if s.CommittedBytes != 0 || s.ReservedBytes != 2200 || *s.AvailableBytes != 2800 ||
		len(s.PendingUploads) != 1 || len(s.PendingBatches) != 1 {
		t.Fatalf("after initiating folder batch: %+v", s)
	}
	if b := s.PendingBatches[0]; b.ID != batchID || b.Name != "PartialFolder" || b.FileCount != 2 ||
		b.ReservedBytes != 1300 || b.CommittedBytes != 0 || b.TotalBytes != 1300 || b.ParentID != dir.ID {
		t.Fatalf("initial pending batch = %+v", b)
	}

	// Complete ONLY the first file of PartialFolder -> still unrevealed, splits committedBytes=500 & reservedBytes=800.
	partData := call(user, "POST", "/uploads/"+batchSessions[0].ID+"/parts", map[string]any{"numbers": []int{1}}, 200)
	var urls []struct {
		URL string `json:"url"`
	}
	decode(t, partData, &urls)
	putUploadPart(t, server.URL, user, urls[0].URL, make([]byte, 500))
	call(user, "POST", "/uploads/"+batchSessions[0].ID+"/complete", nil, 200)

	s = getStorage()
	if s.CommittedBytes != 500 || s.ReservedBytes != 1700 || s.UsedBytes != 2200 || *s.AvailableBytes != 2800 ||
		len(s.PendingBatches) != 1 {
		t.Fatalf("after completing 1/2 batch files: %+v", s)
	}
	if b := s.PendingBatches[0]; b.ReservedBytes != 800 || b.CommittedBytes != 500 || b.TotalBytes != 1300 {
		t.Fatalf("partial pending batch = %+v", b)
	}

	// 4. Complete and reveal a separate 1-file folder batch -> must NOT appear in pendingBatches once revealed!
	var revSessions []struct {
		ID      string `json:"id"`
		BatchID string `json:"batchId"`
	}
	decode(t, call(user, "POST", "/upload-batches", map[string]any{
		"parentId": dir.ID,
		"name":     "RevealedFolder",
		"files":    []map[string]any{{"path": "only.bin", "size": 300}},
	}, 201), &revSessions)
	revPartData := call(user, "POST", "/uploads/"+revSessions[0].ID+"/parts", map[string]any{"numbers": []int{1}}, 200)
	decode(t, revPartData, &urls)
	putUploadPart(t, server.URL, user, urls[0].URL, make([]byte, 300))
	call(user, "POST", "/uploads/"+revSessions[0].ID+"/complete", nil, 200)

	s = getStorage()
	if s.CommittedBytes != 800 || s.ReservedBytes != 1700 || len(s.PendingBatches) != 1 || s.PendingBatches[0].ID != batchID {
		t.Fatalf("revealed batch should disappear from pendingBatches: %+v", s)
	}

	// 5. Cancel PartialFolder -> immediately frees BOTH its 500 B committed AND 800 B reserved bytes!
	call(user, "DELETE", "/upload-batches/"+batchID, nil, 204)
	s = getStorage()
	if s.CommittedBytes != 300 || s.ReservedBytes != 900 || s.UsedBytes != 1200 || *s.AvailableBytes != 3800 ||
		len(s.PendingBatches) != 0 {
		t.Fatalf("after cancelling partial batch: %+v", s)
	}

	// 6. Cancel stuck.bin -> immediately frees 900 B reserved bytes!
	call(user, "DELETE", "/uploads/"+pendingSess.ID, nil, 204)
	s = getStorage()
	if s.CommittedBytes != 300 || s.ReservedBytes != 0 || s.UsedBytes != 300 || *s.AvailableBytes != 4700 ||
		len(s.PendingUploads) != 0 {
		t.Fatalf("after cancelling pending single upload: %+v", s)
	}

	// 7. When an ancestor Organization total ceiling becomes tighter than User Quota,
	// effectiveScope switches to organization_total with org ceiling & usage.
	csvHeavy := fmt.Sprintf("username,display_name,password,organization_id\nheavy-peer,Heavy Peer,Pass12345!,%d\n", org.ID)
	call(admin, "POST", "/users/import", map[string]any{"csv": csvHeavy}, 201)
	decode(t, call(admin, "GET", "/managed-users", nil, 200), &managed)
	var heavyID int64
	for _, u := range managed {
		if u.Username == "heavy-peer" {
			heavyID = u.ID
		}
	}
	// Temporarily raise SelfServiceOrg to 20000 so heavy-peer can upload 9500 B, then lower org back to 10000.
	call(admin, "PATCH", fmt.Sprintf("/organizations/%d", org.ID), map[string]any{"name": "SelfServiceOrg", "quotaBytes": 20000}, 200)
	heavy := newBrowser(t, server)
	call(heavy, "POST", "/session", map[string]any{"username": "heavy-peer", "password": "Pass12345!"}, 200)
	completeSingleUpload(t, server.URL, heavy, dir.ID, "heavy.bin", make([]byte, 9500), "")
	// Lower org quota back to 10000 (allocated = 5000 for self-user, so 10000 >= 5000 is allowed).
	// Now org total used = 300 + 9500 = 9800 -> org remaining = 200 < self-user remaining 4700!
	call(admin, "PATCH", fmt.Sprintf("/organizations/%d", org.ID), map[string]any{"name": "SelfServiceOrg", "quotaBytes": 10000}, 200)
	_ = heavyID

	s = getStorage()
	if s.AvailableBytes == nil || *s.AvailableBytes != 200 ||
		s.EffectiveLimitBytes == nil || *s.EffectiveLimitBytes != 10000 ||
		s.EffectiveUsedBytes != 9800 ||
		s.EffectiveScope == nil || *s.EffectiveScope != "organization_total" ||
		s.ConstrainingOrganization == nil || s.ConstrainingOrganization.Name != "SelfServiceOrg" ||
		s.ConstrainingOrganization.RemainingBytes != 200 ||
		s.ConstrainingOrganization.ConstraintKind != "organization_total" {
		t.Fatalf("after org total becomes tighter: %+v", s)
	}
}
