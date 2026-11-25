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

func TestUserBudgetForConstrainingAncestor(t *testing.T) {
	// Hierarchy:
	//   1 RootA (quota 100)
	//     ├─ 2 MidA1 (unlimited)
	//     │   └─ user 10 (quota 40)
	//     ├─ 3 MidA2 (unlimited)
	//     └─ 4 SubCapped (quota 30)
	//         └─ user 11 (quota 10)
	//   5 RootB (quota 50)
	//     └─ user 12 (quota 20)
	//   6 RootUnlimited (unlimited)
	//     └─ user 13 (quota 25)
	// RootA allocated = 40 (user 10) + 30 (SubCapped) = 70 -> unallocated = 30.
	// SubCapped allocated = 10 -> unallocated = 20.
	// RootB allocated = 20 -> unallocated = 30.
	ledger := quota.Evaluate(quota.Snapshot{
		Organizations: []quota.Organization{
			{ID: 1, Name: "RootA", QuotaBytes: ptr(100)},
			{ID: 2, Name: "MidA1", ParentID: ptr(1)},
			{ID: 3, Name: "MidA2", ParentID: ptr(1)},
			{ID: 4, Name: "SubCapped", ParentID: ptr(1), QuotaBytes: ptr(30)},
			{ID: 5, Name: "RootB", QuotaBytes: ptr(50)},
			{ID: 6, Name: "RootUnlimited"},
		},
		Users: []quota.User{
			{ID: 10, OrganizationID: 2, QuotaBytes: ptr(40)},
			{ID: 11, OrganizationID: 4, QuotaBytes: ptr(10)},
			{ID: 12, OrganizationID: 5, QuotaBytes: ptr(20)},
			{ID: 13, OrganizationID: 6, QuotaBytes: ptr(25)},
			{ID: 14, OrganizationID: 2, QuotaBytes: nil},
		},
	})

	for _, tc := range []struct {
		name            string
		userID          *int64
		targetOrgID     int64
		wantNil         bool
		wantAncestorID  int64
		wantUnallocated int64
		wantMaxAllowed  int64
	}{
		{"new user under uncapped MidA1 bounded by RootA", nil, 2, false, 1, 30, 30},
		{"capped user 10 staying in MidA1 adds own 40 back", ptr(10), 2, false, 1, 30, 70},
		{"capped user 10 moving to sibling uncapped MidA2 shares same RootA", ptr(10), 3, false, 1, 30, 70},
		{"capped user 10 moving into SubCapped bounded by SubCapped 20", ptr(10), 4, false, 4, 20, 20},
		{"capped user 10 moving into RootB bounded by RootB 30", ptr(10), 5, false, 5, 30, 30},
		{"capped user 10 moving into RootUnlimited has no ceiling", ptr(10), 6, true, 0, 0, 0},
		{"uncapped user 14 staying in MidA1 gets RootA remaining 30", ptr(14), 2, false, 1, 30, 30},
		{"capped user 11 staying in SubCapped adds own 10 back", ptr(11), 4, false, 4, 20, 30},
		{"capped user 11 moving up to MidA1 bounded by RootA remaining 30", ptr(11), 2, false, 1, 30, 30},
		{"capped user 13 under unlimited org moving to RootB gets RootB 30", ptr(13), 5, false, 5, 30, 30},
		{"nonexistent target org returns nil", ptr(10), 999, true, 0, 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := ledger.UserBudgetFor(tc.userID, tc.targetOrgID)
			if tc.wantNil {
				if b != nil {
					t.Fatalf("got %+v, want nil", b)
				}
				return
			}
			if b == nil {
				t.Fatalf("got nil, want ancestor %d", tc.wantAncestorID)
			}
			if b.AncestorID != tc.wantAncestorID || b.AncestorUnallocatedBytes != tc.wantUnallocated || b.MaxAllowedQuotaBytes != tc.wantMaxAllowed {
				t.Fatalf("budget = %+v, want ancestor=%d unallocated=%d max=%d",
					b, tc.wantAncestorID, tc.wantUnallocated, tc.wantMaxAllowed)
			}
		})
	}
}

func TestValidateUserQuotasAndAtomicMoves(t *testing.T) {
	// Hierarchy:
	//   1 RootA (quota 100)
	//     ├─ 2 MidA1 (unlimited)
	//     │   └─ 3 DeepA (unlimited)
	//     │       ├─ user 10 (quota 40, committed 35, reserved 0)
	//     │       └─ user 11 (unlimited, committed 10)
	//     ├─ 4 MidA2 (unlimited)
	//     └─ 5 SubCapped (quota 30)
	//         └─ user 12 (quota 20)
	//   6 RootB (quota 50)
	//     └─ user 13 (quota 35)
	//   7 RootUnlimited (unlimited)
	//     └─ user 14 (quota 500, committed 200)
	// RootA allocated = 40 (user 10) + 30 (SubCapped) = 70 -> remaining 30.
	// SubCapped allocated = 20 -> remaining 10.
	// RootB allocated = 35 -> remaining 15.
	ledger := quota.Evaluate(quota.Snapshot{
		Organizations: []quota.Organization{
			{ID: 1, Name: "RootA", QuotaBytes: ptr(100)},
			{ID: 2, Name: "MidA1", ParentID: ptr(1)},
			{ID: 3, Name: "DeepA", ParentID: ptr(2)},
			{ID: 4, Name: "MidA2", ParentID: ptr(1)},
			{ID: 5, Name: "SubCapped", ParentID: ptr(1), QuotaBytes: ptr(30)},
			{ID: 6, Name: "RootB", QuotaBytes: ptr(50)},
			{ID: 7, Name: "RootUnlimited"},
		},
		Users: []quota.User{
			{ID: 10, OrganizationID: 3, QuotaBytes: ptr(40), CommittedBytes: 35},
			{ID: 11, OrganizationID: 3, QuotaBytes: nil, CommittedBytes: 10},
			{ID: 12, OrganizationID: 5, QuotaBytes: ptr(20)},
			{ID: 13, OrganizationID: 6, QuotaBytes: ptr(35)},
			{ID: 14, OrganizationID: 7, QuotaBytes: ptr(500), CommittedBytes: 200},
		},
	})

	for _, tc := range []struct {
		name      string
		userID    int64
		orgID     int64
		quota     *int64
		wantKind  quota.ViolationKind
		wantOrg   int64
		wantAvail int64
		wantReq   int64
	}{
		{"set quota on uncapped user within RootA budget across two uncapped mids", 11, 3, ptr(30), "", 0, 0, 0},
		{"set quota on uncapped user exceeding RootA across two uncapped mids", 11, 3, ptr(31), quota.ViolationAncestorBudgetExceeded, 1, 30, 31},
		{"raise capped user to exact RootA remaining (40+30=70)", 10, 3, ptr(70), "", 0, 0, 0},
		{"raise capped user past RootA ceiling (71)", 10, 3, ptr(71), quota.ViolationAncestorBudgetExceeded, 1, 70, 71},
		{"lower user quota below current usage (35 -> 10) allowed", 10, 3, ptr(10), "", 0, 0, 0},
		{"zero user quota below current usage allowed", 10, 3, ptr(0), "", 0, 0, 0},
		{"clear user quota to unlimited allowed", 10, 3, nil, "", 0, 0, 0},
		{"set large user quota inside unlimited org allowed", 14, 7, ptr(9999), "", 0, 0, 0},
		{"move capped user within same capped ancestor subtree preserves quota", 10, 4, ptr(40), "", 0, 0, 0},
		{"move capped user to RootB preserving 40 rejected (RootB remaining 15)", 10, 6, ptr(40), quota.ViolationAncestorBudgetExceeded, 6, 15, 40},
		{"atomic move to RootB lowering quota to 15 succeeds", 10, 6, ptr(15), "", 0, 0, 0},
		{"atomic move to RootB zeroing quota succeeds", 10, 6, ptr(0), "", 0, 0, 0},
		{"atomic move to RootB clearing quota to unlimited succeeds", 10, 6, nil, "", 0, 0, 0},
		{"move capped user from SubCapped (20) up to MidA2 (RootA remaining 30) succeeds", 12, 4, ptr(20), "", 0, 0, 0},
		{"move capped user from DeepA (40) into SubCapped (remaining 10) rejected", 10, 5, ptr(40), quota.ViolationAncestorBudgetExceeded, 5, 10, 40},
		{"atomic move into SubCapped lowering quota to 10 succeeds", 10, 5, ptr(10), "", 0, 0, 0},
		{"move uncapped user into RootB succeeds even if RootB tight", 11, 6, nil, "", 0, 0, 0},
		{"move capped user into unlimited org preserves quota", 10, 7, ptr(40), "", 0, 0, 0},
		{"negative user quota rejected", 10, 3, ptr(-1), quota.ViolationInvalidQuota, 0, 0, 0},
		{"unknown target org rejected", 10, 999, ptr(10), quota.ViolationOrganizationNotFound, 0, 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := ledger.ValidateUserChange(tc.userID, tc.orgID, tc.quota)
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
			if tc.wantAvail != 0 && v.AvailableBytes != tc.wantAvail {
				t.Fatalf("violation available = %d, want %d (%+v)", v.AvailableBytes, tc.wantAvail, v)
			}
			if tc.wantReq != 0 && v.RequiredBytes != tc.wantReq {
				t.Fatalf("violation required = %d, want %d (%+v)", v.RequiredBytes, tc.wantReq, v)
			}
		})
	}
}

func TestOrganizationDowngradeAndMoveBlockedByUserQuotas(t *testing.T) {
	// Hierarchy:
	//   1 RootA (quota 100)
	//     ├─ user 1 (quota 20)
	//     ├─ 2 UncappedMid (unlimited)
	//     │   ├─ user 2 (quota 35)
	//     │   └─ 3 CappedLeaf (quota 25)
	//     │       └─ user 3 (quota 20)
	//   4 RootB (quota 50)
	//     └─ user 4 (quota 10)
	// RootA allocated = 20 (user 1) + 35 (user 2 via UncappedMid) + 25 (CappedLeaf) = 80.
	// UncappedMid allocated = 35 (user 2) + 25 (CappedLeaf) = 60.
	// RootB remaining = 40.
	ledger := quota.Evaluate(quota.Snapshot{
		Organizations: []quota.Organization{
			{ID: 1, Name: "RootA", QuotaBytes: ptr(100)},
			{ID: 2, Name: "UncappedMid", ParentID: ptr(1)},
			{ID: 3, Name: "CappedLeaf", ParentID: ptr(2), QuotaBytes: ptr(25)},
			{ID: 4, Name: "RootB", QuotaBytes: ptr(50)},
		},
		Users: []quota.User{
			{ID: 1, OrganizationID: 1, QuotaBytes: ptr(20)},
			{ID: 2, OrganizationID: 2, QuotaBytes: ptr(35)},
			{ID: 3, OrganizationID: 3, QuotaBytes: ptr(20)},
			{ID: 4, OrganizationID: 4, QuotaBytes: ptr(10)},
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
		{"lower RootA to exact sum 80 (direct user + mid user + child org)", 1, nil, ptr(80), "", 0},
		{"lower RootA below sum 79 rejected", 1, nil, ptr(79), quota.ViolationQuotaBelowAllocated, 1},
		{"lower CappedLeaf to direct user quota 20 allowed", 3, ptr(2), ptr(20), "", 0},
		{"lower CappedLeaf below direct user quota 19 rejected", 3, ptr(2), ptr(19), quota.ViolationQuotaBelowAllocated, 3},
		{"cap UncappedMid at 60 (user 2 + CappedLeaf) allowed", 2, ptr(1), ptr(60), "", 0},
		{"cap UncappedMid at 59 below user 2 + CappedLeaf rejected", 2, ptr(1), ptr(59), quota.ViolationQuotaBelowAllocated, 2},
		{"move UncappedMid (carrying user 2=35 + CappedLeaf=25) into RootB (remaining 40) rejected", 2, ptr(4), nil, quota.ViolationAncestorBudgetExceeded, 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := ledger.ValidateUpdateOrganization(tc.orgID, tc.parentID, tc.quota)
			if tc.wantKind == "" {
				if v != nil {
					t.Fatalf("got unexpected violation: %+v", v)
				}
				return
			}
			if v == nil || v.Kind != tc.wantKind || (tc.wantOrg != 0 && v.OrganizationID != tc.wantOrg) {
				t.Fatalf("violation = %+v, want kind=%q org=%d", v, tc.wantKind, tc.wantOrg)
			}
		})
	}
}

func TestIsolatedUnallocatedPoolsAndMultiAncestorPhysicalCeilings(t *testing.T) {
	t.Run("fully allocated org isolates uncapped pool to zero even when capped user used zero", func(t *testing.T) {
		ledger := quota.Evaluate(quota.Snapshot{
			Organizations: []quota.Organization{
				{ID: 1, Name: "FullyAllocated", QuotaBytes: ptr(100)},
				{ID: 2, Name: "UncappedTeam", ParentID: ptr(1)},
			},
			Users: []quota.User{
				{ID: 10, OrganizationID: 1, QuotaBytes: ptr(100), CommittedBytes: 0},
				{ID: 11, OrganizationID: 2, QuotaBytes: nil, CommittedBytes: 0},
			},
		})
		// Capped user 10 gets their full guaranteed 100.
		if d := ledger.CheckWrite(10, 100); !d.Allowed || d.AvailableBytes == nil || *d.AvailableBytes != 100 {
			t.Fatalf("capped user 10 = %+v, want allowed with avail 100", d)
		}
		// Uncapped user 11 in UncappedTeam gets 0 from isolated pool despite 100 physical headroom!
		if d := ledger.CheckWrite(11, 1); d.Allowed || d.Scope != quota.ScopeOrganizationPool || d.ConstrainingOrgID != 1 || d.AvailableBytes == nil || *d.AvailableBytes != 0 {
			t.Fatalf("uncapped user 11 = %+v, want denied by pool on org 1 with avail 0", d)
		}
		// Zero-byte op still allowed.
		if d := ledger.CheckWrite(11, 0); !d.Allowed {
			t.Fatalf("uncapped user 11 zero-byte op = %+v, want allowed", d)
		}
	})

	t.Run("multiple uncapped sub-orgs share one isolated unallocated pool without invading capped peers", func(t *testing.T) {
		// Root (100):
		//   - user 10 (capped 60, used 10) -> remaining 50 for user 10
		//   - UncappedA: user 11 (uncapped, committed 12, reserved 3 -> 15)
		//   - UncappedB: user 12 (uncapped, committed 10, reserved 5 -> 15)
		// Unallocated pool = 100 - 60 = 40; UncappedPoolUsed = 15 + 15 = 30 -> pool headroom = 10!
		// Root physical used = 10 + 15 + 15 = 40 -> physical headroom = 60.
		ledger := quota.Evaluate(quota.Snapshot{
			Organizations: []quota.Organization{
				{ID: 1, Name: "Root", QuotaBytes: ptr(100)},
				{ID: 2, Name: "UncappedA", ParentID: ptr(1)},
				{ID: 3, Name: "UncappedB", ParentID: ptr(1)},
			},
			Users: []quota.User{
				{ID: 10, OrganizationID: 1, QuotaBytes: ptr(60), CommittedBytes: 10},
				{ID: 11, OrganizationID: 2, CommittedBytes: 12, ReservedBytes: 3},
				{ID: 12, OrganizationID: 3, CommittedBytes: 10, ReservedBytes: 5},
			},
		})
		for _, uid := range []int64{11, 12} {
			if d := ledger.CheckWrite(uid, 10); !d.Allowed || d.AvailableBytes == nil || *d.AvailableBytes != 10 {
				t.Fatalf("uncapped user %d write 10 = %+v", uid, d)
			}
			if d := ledger.CheckWrite(uid, 11); d.Allowed || d.Scope != quota.ScopeOrganizationPool || d.ConstrainingOrgID != 1 || d.AvailableBytes == nil || *d.AvailableBytes != 10 {
				t.Fatalf("uncapped user %d write 11 = %+v", uid, d)
			}
		}
		// Capped user 10 still gets full 50 regardless of uncapped peers using 30 of the 40 pool.
		if d := ledger.CheckWrite(10, 50); !d.Allowed || d.AvailableBytes == nil || *d.AvailableBytes != 50 {
			t.Fatalf("capped user 10 write 50 = %+v", d)
		}
		if d := ledger.CheckWrite(10, 51); d.Allowed || d.Scope != quota.ScopeUser || d.AvailableBytes == nil || *d.AvailableBytes != 50 {
			t.Fatalf("capped user 10 write 51 = %+v", d)
		}
	})

	t.Run("multi-ancestor physical ceiling overrides child pool and user quota", func(t *testing.T) {
		// GrandParent (quota 100)
		//   ├─ ChildCapped (quota 40)
		//   │   ├─ user 10 (quota 30, used 5)  -> user headroom 25, ChildCapped headroom 30
		//   │   └─ user 11 (uncapped, used 5)  -> ChildCapped pool = 10, pool headroom 5
		//   └─ OverQuotaBranch (unlimited)
		//       └─ user 12 (quota 20, committed 87) -> over-quota after downgrade
		// GrandParent total used = 5 + 5 + 87 = 97 -> GrandParent physical headroom = 3!
		ledger := quota.Evaluate(quota.Snapshot{
			Organizations: []quota.Organization{
				{ID: 1, Name: "GrandParent", QuotaBytes: ptr(100)},
				{ID: 2, Name: "ChildCapped", ParentID: ptr(1), QuotaBytes: ptr(40)},
				{ID: 3, Name: "OverQuotaBranch", ParentID: ptr(1)},
			},
			Users: []quota.User{
				{ID: 10, OrganizationID: 2, QuotaBytes: ptr(30), CommittedBytes: 5},
				{ID: 11, OrganizationID: 2, CommittedBytes: 5},
				{ID: 12, OrganizationID: 3, QuotaBytes: ptr(20), CommittedBytes: 87},
			},
		})
		// Both user 10 (capped) and user 11 (uncapped) are capped at 3 by GrandParent physical total.
		for _, uid := range []int64{10, 11} {
			if d := ledger.CheckWrite(uid, 3); !d.Allowed || d.AvailableBytes == nil || *d.AvailableBytes != 3 {
				t.Fatalf("user %d write 3 = %+v", uid, d)
			}
			if d := ledger.CheckWrite(uid, 4); d.Allowed || d.Scope != quota.ScopeOrganizationTotal || d.ConstrainingOrgID != 1 || d.ConstrainingOrgName != "GrandParent" || d.AvailableBytes == nil || *d.AvailableBytes != 3 {
				t.Fatalf("user %d write 4 = %+v, want GrandParent physical ceiling avail=3", uid, d)
			}
		}
	})

	t.Run("over-quota capped sibling shrinks physical ceiling below unallocated pool", func(t *testing.T) {
		// Org (quota 50)
		//   - user 10 (quota 20, committed 45 — lowered below usage!)
		//   - user 11 (uncapped, committed 0)
		// Unallocated pool = 50 - 20 = 30 (pool headroom 30), BUT Org physical headroom = 50 - 45 = 5!
		ledger := quota.Evaluate(quota.Snapshot{
			Organizations: []quota.Organization{
				{ID: 1, Name: "TightOrg", QuotaBytes: ptr(50)},
			},
			Users: []quota.User{
				{ID: 10, OrganizationID: 1, QuotaBytes: ptr(20), CommittedBytes: 45},
				{ID: 11, OrganizationID: 1, CommittedBytes: 0},
			},
		})
		if d := ledger.CheckWrite(11, 5); !d.Allowed || d.AvailableBytes == nil || *d.AvailableBytes != 5 {
			t.Fatalf("user 11 write 5 = %+v", d)
		}
		if d := ledger.CheckWrite(11, 6); d.Allowed || d.Scope != quota.ScopeOrganizationTotal || d.ConstrainingOrgID != 1 || d.AvailableBytes == nil || *d.AvailableBytes != 5 {
			t.Fatalf("user 11 write 6 = %+v, want TightOrg physical ceiling avail=5", d)
		}
	})

	t.Run("unlimited hierarchy vs capped user in unlimited org", func(t *testing.T) {
		ledger := quota.Evaluate(quota.Snapshot{
			Organizations: []quota.Organization{
				{ID: 1, Name: "UnlimitedRoot"},
				{ID: 2, Name: "UnlimitedChild", ParentID: ptr(1)},
			},
			Users: []quota.User{
				{ID: 10, OrganizationID: 2, QuotaBytes: nil, CommittedBytes: 1000},
				{ID: 11, OrganizationID: 2, QuotaBytes: ptr(50), CommittedBytes: 20, ReservedBytes: 10},
			},
		})
		if d := ledger.CheckWrite(10, 1<<40); !d.Allowed || d.AvailableBytes != nil || d.Scope != quota.ScopeNone {
			t.Fatalf("unlimited user = %+v, want unlimited allowed", d)
		}
		if d := ledger.CheckWrite(11, 20); !d.Allowed || d.AvailableBytes == nil || *d.AvailableBytes != 20 {
			t.Fatalf("capped user in unlimited org write 20 = %+v", d)
		}
		if d := ledger.CheckWrite(11, 21); d.Allowed || d.Scope != quota.ScopeUser || d.AvailableBytes == nil || *d.AvailableBytes != 20 {
			t.Fatalf("capped user in unlimited org write 21 = %+v", d)
		}
	})
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

func TestUserStorageSummary(t *testing.T) {
	t.Run("unknown user returns false", func(t *testing.T) {
		ledger := quota.Evaluate(quota.Snapshot{
			Organizations: []quota.Organization{{ID: 1, Name: "Default"}},
		})
		if _, ok := ledger.UserStorage(999); ok {
			t.Fatal("expected unknown user to return ok=false")
		}
	})

	t.Run("completely unlimited user has nil limits and no constraining organization", func(t *testing.T) {
		ledger := quota.Evaluate(quota.Snapshot{
			Organizations: []quota.Organization{
				{ID: 1, Name: "Root"},
				{ID: 2, Name: "Child", ParentID: ptr(1)},
			},
			Users: []quota.User{
				{ID: 10, OrganizationID: 2, CommittedBytes: 400, ReservedBytes: 100},
			},
		})
		got, ok := ledger.UserStorage(10)
		if !ok {
			t.Fatal("expected user 10 to exist")
		}
		if got.CommittedBytes != 400 || got.ReservedBytes != 100 || got.UsedBytes != 500 {
			t.Fatalf("usage = (%d,%d,%d), want (400,100,500)", got.CommittedBytes, got.ReservedBytes, got.UsedBytes)
		}
		if got.QuotaBytes != nil || got.AvailableBytes != nil || got.EffectiveLimitBytes != nil {
			t.Fatalf("expected nil quota/available/effectiveLimit, got %+v", got)
		}
		if got.EffectiveUsedBytes != 500 || got.EffectiveScope != quota.ScopeNone || got.ConstrainingOrganization != nil {
			t.Fatalf("unexpected unlimited summary: %+v", got)
		}
	})

	t.Run("user quota in unlimited org uses user quota as effective ceiling including zero-byte cap and over-quota downgrade", func(t *testing.T) {
		ledger := quota.Evaluate(quota.Snapshot{
			Organizations: []quota.Organization{{ID: 1, Name: "Unlimited"}},
			Users: []quota.User{
				{ID: 10, OrganizationID: 1, QuotaBytes: ptr(1000), CommittedBytes: 600, ReservedBytes: 250},
				{ID: 11, OrganizationID: 1, QuotaBytes: ptr(0), CommittedBytes: 0, ReservedBytes: 0},
				{ID: 12, OrganizationID: 1, QuotaBytes: ptr(500), CommittedBytes: 700, ReservedBytes: 50},
			},
		})

		u10, ok := ledger.UserStorage(10)
		if !ok || u10.QuotaBytes == nil || *u10.QuotaBytes != 1000 || u10.AvailableBytes == nil || *u10.AvailableBytes != 150 ||
			u10.EffectiveLimitBytes == nil || *u10.EffectiveLimitBytes != 1000 || u10.EffectiveUsedBytes != 850 ||
			u10.EffectiveScope != quota.ScopeUser || u10.ConstrainingOrganization != nil {
			t.Fatalf("user 10 summary = %+v", u10)
		}

		u11, ok := ledger.UserStorage(11)
		if !ok || u11.QuotaBytes == nil || *u11.QuotaBytes != 0 || u11.AvailableBytes == nil || *u11.AvailableBytes != 0 ||
			u11.EffectiveLimitBytes == nil || *u11.EffectiveLimitBytes != 0 || u11.EffectiveUsedBytes != 0 ||
			u11.EffectiveScope != quota.ScopeUser || u11.ConstrainingOrganization != nil {
			t.Fatalf("zero-cap user 11 summary = %+v", u11)
		}

		u12, ok := ledger.UserStorage(12)
		if !ok || u12.AvailableBytes == nil || *u12.AvailableBytes != 0 ||
			u12.EffectiveLimitBytes == nil || *u12.EffectiveLimitBytes != 500 || u12.EffectiveUsedBytes != 750 ||
			u12.EffectiveScope != quota.ScopeUser {
			t.Fatalf("over-quota user 12 summary = %+v", u12)
		}
	})

	t.Run("uncapped user under capped org uses isolated unallocated pool as effective ceiling", func(t *testing.T) {
		// Eng (quota 1200):
		//   - capped peer (quota 1000, used 100)
		//   - uncapped user 11 (committed 120, reserved 50 -> 170)
		//   - UncappedTeam -> uncapped user 12 (committed 10 -> 10)
		// Pool = 1200 - 1000 = 200; poolUsed = 180; poolRemaining = 20 (90% used).
		// Org total = 1200; totalUsed = 280; totalRemaining = 920.
		ledger := quota.Evaluate(quota.Snapshot{
			Organizations: []quota.Organization{
				{ID: 1, Name: "Eng", QuotaBytes: ptr(1200)},
				{ID: 2, Name: "UncappedTeam", ParentID: ptr(1)},
			},
			Users: []quota.User{
				{ID: 10, OrganizationID: 1, QuotaBytes: ptr(1000), CommittedBytes: 100},
				{ID: 11, OrganizationID: 1, CommittedBytes: 120, ReservedBytes: 50},
				{ID: 12, OrganizationID: 2, CommittedBytes: 10},
			},
		})
		got, ok := ledger.UserStorage(11)
		if !ok {
			t.Fatal("expected user 11")
		}
		if got.CommittedBytes != 120 || got.ReservedBytes != 50 || got.UsedBytes != 170 || got.QuotaBytes != nil {
			t.Fatalf("user 11 own fields = %+v", got)
		}
		if got.AvailableBytes == nil || *got.AvailableBytes != 20 ||
			got.EffectiveLimitBytes == nil || *got.EffectiveLimitBytes != 200 ||
			got.EffectiveUsedBytes != 180 || got.EffectiveScope != quota.ScopeOrganizationPool {
			t.Fatalf("user 11 effective fields = %+v, want avail=20 limit=200 used=180 scope=organization_pool", got)
		}
		if got.ConstrainingOrganization == nil ||
			got.ConstrainingOrganization.Name != "Eng" ||
			got.ConstrainingOrganization.QuotaBytes != 1200 ||
			got.ConstrainingOrganization.UsedBytes != 280 ||
			got.ConstrainingOrganization.AllocatedBytes != 1000 ||
			got.ConstrainingOrganization.UnallocatedPoolBytes != 200 ||
			got.ConstrainingOrganization.UnallocatedPoolUsedBytes != 180 ||
			got.ConstrainingOrganization.RemainingBytes != 20 ||
			got.ConstrainingOrganization.ConstraintKind != quota.ScopeOrganizationPool {
			t.Fatalf("user 11 constraining org = %+v", got.ConstrainingOrganization)
		}
	})

	t.Run("zero-byte unallocated pool reports zero effectiveLimitBytes and exceeded headroom", func(t *testing.T) {
		ledger := quota.Evaluate(quota.Snapshot{
			Organizations: []quota.Organization{{ID: 1, Name: "FullOrg", QuotaBytes: ptr(1000)}},
			Users: []quota.User{
				{ID: 10, OrganizationID: 1, QuotaBytes: ptr(1000), CommittedBytes: 0},
				{ID: 11, OrganizationID: 1, CommittedBytes: 0},
			},
		})
		got, ok := ledger.UserStorage(11)
		if !ok || got.AvailableBytes == nil || *got.AvailableBytes != 0 ||
			got.EffectiveLimitBytes == nil || *got.EffectiveLimitBytes != 0 ||
			got.EffectiveUsedBytes != 0 || got.EffectiveScope != quota.ScopeOrganizationPool ||
			got.ConstrainingOrganization == nil || got.ConstrainingOrganization.Name != "FullOrg" ||
			got.ConstrainingOrganization.RemainingBytes != 0 {
			t.Fatalf("zero-pool user 11 = %+v", got)
		}
	})

	t.Run("capped user under capped org keeps user ceiling when tighter and switches to org ceiling when org is tighter", func(t *testing.T) {
		// GrandParent (quota 1000):
		//   - Child (quota 400):
		//       - user 10 (quota 300, committed 50 -> user headroom 250; Child total headroom 350)
		//   - HeavyBranch (unlimited):
		//       - user 12 (quota 200, committed 900 -> GrandParent total used = 950, headroom = 50!)
		ledger := quota.Evaluate(quota.Snapshot{
			Organizations: []quota.Organization{
				{ID: 1, Name: "GrandParent", QuotaBytes: ptr(1000)},
				{ID: 2, Name: "Child", ParentID: ptr(1), QuotaBytes: ptr(400)},
				{ID: 3, Name: "HeavyBranch", ParentID: ptr(1)},
			},
			Users: []quota.User{
				{ID: 10, OrganizationID: 2, QuotaBytes: ptr(300), CommittedBytes: 50},
				{ID: 12, OrganizationID: 3, QuotaBytes: ptr(200), CommittedBytes: 900},
			},
		})
		got, ok := ledger.UserStorage(10)
		if !ok {
			t.Fatal("expected user 10")
		}
		if got.AvailableBytes == nil || *got.AvailableBytes != 50 ||
			got.EffectiveLimitBytes == nil || *got.EffectiveLimitBytes != 1000 ||
			got.EffectiveUsedBytes != 950 || got.EffectiveScope != quota.ScopeOrganizationTotal {
			t.Fatalf("org-tight user 10 = %+v, want GrandParent total 950/1000 avail=50", got)
		}
		if got.ConstrainingOrganization == nil || got.ConstrainingOrganization.Name != "GrandParent" ||
			got.ConstrainingOrganization.ConstraintKind != quota.ScopeOrganizationTotal ||
			got.ConstrainingOrganization.RemainingBytes != 50 {
			t.Fatalf("org-tight constraining org = %+v", got.ConstrainingOrganization)
		}

		// When GrandParent has plenty of headroom, user 10's personal quota is tighter,
		// while ConstrainingOrganization still reflects the tightest capped ancestor (Child: 350 < GrandParent: 900).
		ledger2 := quota.Evaluate(quota.Snapshot{
			Organizations: []quota.Organization{
				{ID: 1, Name: "GrandParent", QuotaBytes: ptr(1000)},
				{ID: 2, Name: "Child", ParentID: ptr(1), QuotaBytes: ptr(400)},
			},
			Users: []quota.User{
				{ID: 10, OrganizationID: 2, QuotaBytes: ptr(300), CommittedBytes: 50},
			},
		})
		got2, ok := ledger2.UserStorage(10)
		if !ok {
			t.Fatal("expected user 10 in ledger2")
		}
		if got2.AvailableBytes == nil || *got2.AvailableBytes != 250 ||
			got2.EffectiveLimitBytes == nil || *got2.EffectiveLimitBytes != 300 ||
			got2.EffectiveUsedBytes != 50 || got2.EffectiveScope != quota.ScopeUser {
			t.Fatalf("user-tight user 10 = %+v, want user 50/300 avail=250", got2)
		}
		if got2.ConstrainingOrganization == nil || got2.ConstrainingOrganization.Name != "Child" ||
			got2.ConstrainingOrganization.QuotaBytes != 400 ||
			got2.ConstrainingOrganization.UsedBytes != 50 ||
			got2.ConstrainingOrganization.RemainingBytes != 350 ||
			got2.ConstrainingOrganization.ConstraintKind != quota.ScopeOrganizationTotal {
			t.Fatalf("user-tight constraining org = %+v", got2.ConstrainingOrganization)
		}
	})
}


