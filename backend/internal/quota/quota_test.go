package quota_test

import (
	"testing"

	"github.com/liumingjian/ftp-master/backend/internal/quota"
)

func ptr(v int64) *int64 { return &v }

func TestEvaluateRollsUpUsageAndTopLevelAllocations(t *testing.T) {
	// Hierarchy:
	//   1 RootUnlimited (unlimited)
	//     ├─ 2 Eng (quota 100)
	//     │   └─ 3 Platform (quota 40)
	//     │       └─ user 10 (committed 12, reserved 3)
	//     └─ 4 Ops (unlimited)
	//         └─ user 11 (committed 7, reserved 2)
	//   5 Sales (quota 60)
	//     └─ 6 West (quota 25)
	//         └─ user 12 (committed 10, reserved 0)
	//     └─ user 13 (committed 5, reserved 1)
	ledger := quota.Evaluate(quota.Snapshot{
		Organizations: []quota.Organization{
			{ID: 1, Name: "RootUnlimited"},
			{ID: 2, Name: "Eng", ParentID: ptr(1), QuotaBytes: ptr(100)},
			{ID: 3, Name: "Platform", ParentID: ptr(2), QuotaBytes: ptr(40)},
			{ID: 4, Name: "Ops", ParentID: ptr(1)},
			{ID: 5, Name: "Sales", QuotaBytes: ptr(60)},
			{ID: 6, Name: "West", ParentID: ptr(5), QuotaBytes: ptr(25)},
		},
		Users: []quota.User{
			{ID: 10, OrganizationID: 3, CommittedBytes: 12, ReservedBytes: 3},
			{ID: 11, OrganizationID: 4, CommittedBytes: 7, ReservedBytes: 2},
			{ID: 12, OrganizationID: 6, CommittedBytes: 10, ReservedBytes: 0},
			{ID: 13, OrganizationID: 5, CommittedBytes: 5, ReservedBytes: 1},
		},
	})

	for _, tc := range []struct {
		orgID            int64
		committed        int64
		reserved         int64
		used             int64
		allocated        int64
		unallocated      *int64
		uncappedPoolUsed int64
	}{
		{1, 19, 5, 24, 100, nil, 9},
		{2, 12, 3, 15, 40, ptr(60), 0},
		{3, 12, 3, 15, 0, ptr(40), 15},
		{4, 7, 2, 9, 0, nil, 9},
		{5, 15, 1, 16, 25, ptr(35), 6},
		{6, 10, 0, 10, 0, ptr(25), 10},
	} {
		summary, ok := ledger.Organization(tc.orgID)
		if !ok {
			t.Fatalf("org %d missing from ledger", tc.orgID)
		}
		if summary.CommittedBytes != tc.committed || summary.ReservedBytes != tc.reserved || summary.UsedBytes != tc.used {
			t.Fatalf("org %d usage = (%d, %d, %d), want (%d, %d, %d)",
				tc.orgID, summary.CommittedBytes, summary.ReservedBytes, summary.UsedBytes,
				tc.committed, tc.reserved, tc.used)
		}
		if summary.AllocatedBytes != tc.allocated {
			t.Fatalf("org %d allocated = %d, want %d", tc.orgID, summary.AllocatedBytes, tc.allocated)
		}
		if (summary.UnallocatedBytes == nil) != (tc.unallocated == nil) ||
			(summary.UnallocatedBytes != nil && *summary.UnallocatedBytes != *tc.unallocated) {
			t.Fatalf("org %d unallocated = %v, want %v", tc.orgID, summary.UnallocatedBytes, tc.unallocated)
		}
		if summary.UncappedPoolUsedBytes != tc.uncappedPoolUsed {
			t.Fatalf("org %d uncappedPoolUsed = %d, want %d", tc.orgID, summary.UncappedPoolUsedBytes, tc.uncappedPoolUsed)
		}
	}

	platform := ledger.PlatformSummary()
	if platform.CommittedBytes != 34 || platform.ReservedBytes != 6 || platform.UsedBytes != 40 {
		t.Fatalf("platform usage = %+v, want (34, 6, 40)", platform)
	}
	// Top-level allocated: Eng (100 via uncapped RootUnlimited) + Sales (60) = 160 (Platform 40 & West 25 not double-counted).
	if platform.TopLevelAllocatedBytes != 160 {
		t.Fatalf("platform top-level allocated = %d, want 160", platform.TopLevelAllocatedBytes)
	}
}

func TestValidateCreateOrganization(t *testing.T) {
	// Hierarchy:
	//   1 RootUnlimited (unlimited)
	//   2 CappedRoot (quota 100)
	//     ├─ 3 UncappedMid (unlimited)
	//     │   └─ 4 LeafCapped (quota 60)
	//     └─ 5 ZeroOrg (quota 0)
	//   6 CappedWithUser (quota 50)
	//     └─ 7 UncappedWithUser (unlimited)
	//         └─ user 20 (quota 30)
	ledger := quota.Evaluate(quota.Snapshot{
		Organizations: []quota.Organization{
			{ID: 1, Name: "RootUnlimited"},
			{ID: 2, Name: "CappedRoot", QuotaBytes: ptr(100)},
			{ID: 3, Name: "UncappedMid", ParentID: ptr(2)},
			{ID: 4, Name: "LeafCapped", ParentID: ptr(3), QuotaBytes: ptr(60)},
			{ID: 5, Name: "ZeroOrg", ParentID: ptr(2), QuotaBytes: ptr(0)},
			{ID: 6, Name: "CappedWithUser", QuotaBytes: ptr(50)},
			{ID: 7, Name: "UncappedWithUser", ParentID: ptr(6)},
		},
		Users: []quota.User{
			{ID: 20, OrganizationID: 7, QuotaBytes: ptr(30)},
		},
	})

	for _, tc := range []struct {
		name     string
		parentID *int64
		quota    *int64
		wantKind quota.ViolationKind
		wantOrg  int64
	}{
		{"root unlimited", nil, nil, "", 0},
		{"root capped", nil, ptr(500), "", 0},
		{"root zero", nil, ptr(0), "", 0},
		{"child capped under unlimited parent", ptr(1), ptr(200), "", 0},
		{"child fits remaining budget via uncapped mid", ptr(3), ptr(40), "", 0},
		{"child zero under capped parent", ptr(3), ptr(0), "", 0},
		{"child unlimited under capped parent", ptr(3), nil, "", 0},
		{"child exceeds ancestor ceiling across uncapped mid", ptr(3), ptr(41), quota.ViolationAncestorBudgetExceeded, 2},
		{"child zero under zero parent allowed", ptr(5), ptr(0), "", 0},
		{"child positive under zero parent rejected", ptr(5), ptr(1), quota.ViolationAncestorBudgetExceeded, 5},
		{"child fits alongside capped descendant user", ptr(7), ptr(20), "", 0},
		{"child exceeds ancestor alongside capped descendant user", ptr(7), ptr(21), quota.ViolationAncestorBudgetExceeded, 6},
		{"negative quota rejected", ptr(1), ptr(-1), quota.ViolationInvalidQuota, 0},
		{"nonexistent parent rejected", ptr(999), nil, quota.ViolationParentNotFound, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := ledger.ValidateCreateOrganization(tc.parentID, tc.quota)
			if tc.wantKind == "" {
				if v != nil {
					t.Fatalf("got unexpected violation: %+v", v)
				}
				return
			}
			if v == nil || v.Kind != tc.wantKind {
				t.Fatalf("violation = %+v, want kind %q", v, tc.wantKind)
			}
			if tc.wantOrg != 0 && v.OrganizationID != tc.wantOrg {
				t.Fatalf("violation org = %d, want %d (%+v)", v.OrganizationID, tc.wantOrg, v)
			}
		})
	}
}

func TestValidateUpdateAndMoveOrganization(t *testing.T) {
	// Hierarchy:
	//   1 RootA (quota 100)
	//     ├─ 2 MidA (unlimited)
	//     │   ├─ 3 LeafA1 (quota 40, user 1 used 35)
	//     │   └─ 4 LeafA2 (quota 20)
	//     └─ 5 ShieldA (quota 30)
	//         └─ 6 UnderShield (quota 25)
	//   7 RootB (quota 50)
	//     └─ 8 LeafB (quota 10)
	//   9 RootUnlimited (unlimited)
	//     └─ 10 MidUnlimited (unlimited)
	//         └─ 11 LeafUnderUnlimited (quota 45)
	ledger := quota.Evaluate(quota.Snapshot{
		Organizations: []quota.Organization{
			{ID: 1, Name: "RootA", QuotaBytes: ptr(100)},
			{ID: 2, Name: "MidA", ParentID: ptr(1)},
			{ID: 3, Name: "LeafA1", ParentID: ptr(2), QuotaBytes: ptr(40)},
			{ID: 4, Name: "LeafA2", ParentID: ptr(2), QuotaBytes: ptr(20)},
			{ID: 5, Name: "ShieldA", ParentID: ptr(1), QuotaBytes: ptr(30)},
			{ID: 6, Name: "UnderShield", ParentID: ptr(5), QuotaBytes: ptr(25)},
			{ID: 7, Name: "RootB", QuotaBytes: ptr(50)},
			{ID: 8, Name: "LeafB", ParentID: ptr(7), QuotaBytes: ptr(10)},
			{ID: 9, Name: "RootUnlimited"},
			{ID: 10, Name: "MidUnlimited", ParentID: ptr(9)},
			{ID: 11, Name: "LeafUnderUnlimited", ParentID: ptr(10), QuotaBytes: ptr(45)},
		},
		Users: []quota.User{
			{ID: 1, OrganizationID: 3, CommittedBytes: 30, ReservedBytes: 5},
		},
	})

	for _, tc := range []struct {
		name     string
		orgID    int64
		parentID *int64
		quota    *int64
		wantKind quota.ViolationKind
		wantOrg  int64
	}{
		// RootA has allocated = 40 + 20 + 30 = 90 (remaining 10).
		{"lower RootA to exact allocated 90", 1, nil, ptr(90), "", 0},
		{"lower RootA below allocated rejected", 1, nil, ptr(89), quota.ViolationQuotaBelowAllocated, 1},
		{"clear RootA to unlimited allowed", 1, nil, nil, "", 0},
		{"lower LeafA1 below actual usage 35 allowed", 3, ptr(2), ptr(10), "", 0},
		{"zero LeafA1 below actual usage 35 allowed", 3, ptr(2), ptr(0), "", 0},
		{"raise LeafA1 to max remaining in RootA (40+10=50)", 3, ptr(2), ptr(50), "", 0},
		{"raise LeafA1 past RootA ceiling (51)", 3, ptr(2), ptr(51), quota.ViolationAncestorBudgetExceeded, 1},
		{"set MidA quota at descendant sum 60 allowed", 2, ptr(1), ptr(60), "", 0},
		{"set MidA quota to 70 uses RootA remaining 10 allowed", 2, ptr(1), ptr(70), "", 0},
		{"set MidA quota below descendant sum 59 rejected", 2, ptr(1), ptr(59), quota.ViolationQuotaBelowAllocated, 2},
		{"set MidA quota above RootA headroom 71 rejected", 2, ptr(1), ptr(71), quota.ViolationAncestorBudgetExceeded, 1},
		// Moving organizations across branches:
		{"move LeafA1 (40) into RootB (remaining 40) allowed", 3, ptr(7), ptr(40), "", 0},
		{"move LeafA1 (40) into RootB while raising to 41 rejected", 3, ptr(7), ptr(41), quota.ViolationAncestorBudgetExceeded, 7},
		{"move uncapped MidUnlimited (descendant 45) into RootB (remaining 40) rejected", 10, ptr(7), nil, quota.ViolationAncestorBudgetExceeded, 7},
		{"move uncapped MidA (descendant 60) to root unlimited allowed", 2, nil, nil, "", 0},
		{"move UnderShield (25) out of ShieldA directly under RootA (remaining 10) rejected", 6, ptr(1), ptr(25), quota.ViolationAncestorBudgetExceeded, 1},
		{"move UnderShield directly under RootA while lowering to 10 allowed", 6, ptr(1), ptr(10), "", 0},
		// Structural errors:
		{"cycle self parent rejected", 1, ptr(1), ptr(100), quota.ViolationCycle, 0},
		{"cycle descendant parent rejected", 1, ptr(3), ptr(100), quota.ViolationCycle, 0},
		{"unknown org rejected", 999, nil, nil, quota.ViolationOrganizationNotFound, 0},
		{"unknown target parent rejected", 3, ptr(999), ptr(40), quota.ViolationParentNotFound, 0},
		{"negative quota rejected", 3, ptr(2), ptr(-5), quota.ViolationInvalidQuota, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := ledger.ValidateUpdateOrganization(tc.orgID, tc.parentID, tc.quota)
			if tc.wantKind == "" {
				if v != nil {
					t.Fatalf("got unexpected violation: %+v", v)
				}
				return
			}
			if v == nil || v.Kind != tc.wantKind {
				t.Fatalf("violation = %+v, want kind %q", v, tc.wantKind)
			}
			if tc.wantOrg != 0 && v.OrganizationID != tc.wantOrg {
				t.Fatalf("violation org = %d, want %d (%+v)", v.OrganizationID, tc.wantOrg, v)
			}
		})
	}
}

func TestOrgBudgetForConstrainingAncestor(t *testing.T) {
	// 1 RootA (quota 100)
	//   ├─ 2 MidA (unlimited)
	//   │   └─ 3 LeafA (quota 40)
	//   └─ 4 SiblingA (quota 20)
	// 5 RootUnlimited (unlimited)
	ledger := quota.Evaluate(quota.Snapshot{
		Organizations: []quota.Organization{
			{ID: 1, Name: "RootA", QuotaBytes: ptr(100)},
			{ID: 2, Name: "MidA", ParentID: ptr(1)},
			{ID: 3, Name: "LeafA", ParentID: ptr(2), QuotaBytes: ptr(40)},
			{ID: 4, Name: "SiblingA", ParentID: ptr(1), QuotaBytes: ptr(20)},
			{ID: 5, Name: "RootUnlimited"},
		},
	})

	// New org under MidA: RootA remaining is 40, max allowed is 40.
	b := ledger.OrgBudgetFor(nil, ptr(2))
	if b == nil || b.AncestorID != 1 || b.AncestorUnallocatedBytes != 40 || b.MaxAllowedQuotaBytes != 40 {
		t.Fatalf("new under MidA = %+v", b)
	}
	// Editing LeafA staying under MidA: RootA remaining is 40, max allowed for LeafA is 40 + 40 = 80.
	b = ledger.OrgBudgetFor(ptr(3), ptr(2))
	if b == nil || b.AncestorID != 1 || b.AncestorUnallocatedBytes != 40 || b.MaxAllowedQuotaBytes != 80 {
		t.Fatalf("edit LeafA under MidA = %+v", b)
	}
	// Editing MidA staying under RootA: MidA contributes LeafA's 40, so max allowed for MidA is 40 + 40 = 80.
	b = ledger.OrgBudgetFor(ptr(2), ptr(1))
	if b == nil || b.AncestorID != 1 || b.AncestorUnallocatedBytes != 40 || b.MaxAllowedQuotaBytes != 80 {
		t.Fatalf("edit MidA under RootA = %+v", b)
	}
	// Moving LeafA under RootUnlimited: no constraining ancestor.
	if b := ledger.OrgBudgetFor(ptr(3), ptr(5)); b != nil {
		t.Fatalf("under RootUnlimited = %+v, want nil", b)
	}
	// Root org: no constraining ancestor.
	if b := ledger.OrgBudgetFor(nil, nil); b != nil {
		t.Fatalf("root org = %+v, want nil", b)
	}
}

func TestValidateUserChangeAndWriteAdmission(t *testing.T) {
	// 1 Root (quota 100)
	//   ├─ 2 UncappedMid (unlimited)
	//   │   ├─ user 10 (quota 40, committed 30, reserved 5)
	//   │   └─ user 11 (unlimited, committed 15, reserved 0)
	//   └─ 3 CappedChild (quota 30)
	//       └─ user 12 (unlimited, committed 25, reserved 0)
	// Root allocated = 40 (user 10) + 30 (CappedChild) = 70 -> unallocated pool = 30.
	// Root uncappedPoolUsed = 15 (user 11) -> pool headroom = 15.
	// Root total used = 35 + 15 + 25 = 75 -> physical headroom = 25.
	ledger := quota.Evaluate(quota.Snapshot{
		Organizations: []quota.Organization{
			{ID: 1, Name: "Root", QuotaBytes: ptr(100)},
			{ID: 2, Name: "UncappedMid", ParentID: ptr(1)},
			{ID: 3, Name: "CappedChild", ParentID: ptr(1), QuotaBytes: ptr(30)},
		},
		Users: []quota.User{
			{ID: 10, OrganizationID: 2, QuotaBytes: ptr(40), CommittedBytes: 30, ReservedBytes: 5},
			{ID: 11, OrganizationID: 2, CommittedBytes: 15},
			{ID: 12, OrganizationID: 3, CommittedBytes: 25},
		},
	})

	// User config validation:
	if v := ledger.ValidateUserChange(10, 2, ptr(70)); v != nil {
		t.Fatalf("raise user 10 to 70 (40 + 30 pool): %+v", v)
	}
	if v := ledger.ValidateUserChange(10, 2, ptr(71)); v == nil || v.Kind != quota.ViolationAncestorBudgetExceeded || v.OrganizationID != 1 {
		t.Fatalf("raise user 10 to 71 = %+v, want ancestor budget exceeded on Root", v)
	}
	if v := ledger.ValidateUserChange(10, 3, ptr(40)); v == nil || v.Kind != quota.ViolationAncestorBudgetExceeded || v.OrganizationID != 3 {
		t.Fatalf("move user 10 (40) into CappedChild (30) = %+v", v)
	}
	if v := ledger.ValidateUserChange(10, 3, ptr(30)); v != nil {
		t.Fatalf("atomic move user 10 into CappedChild with lowered quota 30: %+v", v)
	}

	// Write admission:
	// User 10: user quota headroom = 40 - 35 = 5, Root physical headroom = 25 -> max 5.
	if d := ledger.CheckWrite(10, 5); !d.Allowed || d.AvailableBytes == nil || *d.AvailableBytes != 5 {
		t.Fatalf("user 10 write 5 = %+v", d)
	}
	if d := ledger.CheckWrite(10, 6); d.Allowed || d.Scope != quota.ScopeUser || d.AvailableBytes == nil || *d.AvailableBytes != 5 {
		t.Fatalf("user 10 write 6 = %+v", d)
	}
	// User 11 (uncapped): Root unallocated pool = 30, pool used = 15 -> pool headroom = 15 (even though Root total headroom is 25!).
	if d := ledger.CheckWrite(11, 15); !d.Allowed || d.AvailableBytes == nil || *d.AvailableBytes != 15 {
		t.Fatalf("user 11 write 15 = %+v", d)
	}
	if d := ledger.CheckWrite(11, 16); d.Allowed || d.Scope != quota.ScopeOrganizationPool || d.ConstrainingOrgID != 1 {
		t.Fatalf("user 11 write 16 = %+v", d)
	}
	// Zero-byte write always allowed even if over quota.
	overQuotaLedger := quota.Evaluate(quota.Snapshot{
		Organizations: []quota.Organization{{ID: 1, Name: "Tight", QuotaBytes: ptr(10)}},
		Users:         []quota.User{{ID: 1, OrganizationID: 1, QuotaBytes: ptr(0), CommittedBytes: 50}},
	})
	if d := overQuotaLedger.CheckWrite(1, 0); !d.Allowed {
		t.Fatalf("zero-byte write should be allowed: %+v", d)
	}
	if d := overQuotaLedger.CheckWrite(1, 1); d.Allowed || d.AvailableBytes == nil || *d.AvailableBytes != 0 {
		t.Fatalf("1-byte write over quota = %+v", d)
	}
}

func TestFormatBytes(t *testing.T) {
	for _, tc := range []struct {
		in   int64
		want string
	}{
		{0, "0 B"},
		{512, "512 B"},
		{1024, "1 KB"},
		{1536, "1.5 KB"},
		{1024 * 1024, "1 MB"},
		{5 * 1024 * 1024 * 1024, "5 GB"},
		{2 * 1024 * 1024 * 1024 * 1024, "2 TB"},
	} {
		if got := quota.FormatBytes(tc.in); got != tc.want {
			t.Fatalf("FormatBytes(%d) = %q, want %q", tc.in, got, tc.want)
		}
	}
}


