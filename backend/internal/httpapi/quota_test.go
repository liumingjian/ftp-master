package httpapi

import (
	"strings"
	"testing"

	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/quota"
)

func TestQuotaExceededResponseFormatting(t *testing.T) {
	int64Ptr := func(v int64) *int64 { return &v }

	cases := []struct {
		name         string
		decision     quota.WriteDecision
		wantScope    api.QuotaExceededErrorScope
		wantOrgName  string
		wantAvail    int64
		wantRequired int64
		wantSubstrs  []string
	}{
		{
			name: "user quota exceeded",
			decision: quota.WriteDecision{
				Allowed:        false,
				Scope:          quota.ScopeUser,
				RequiredBytes:  2 * 1024 * 1024,
				AvailableBytes: int64Ptr(512 * 1024),
			},
			wantScope:    api.QuotaExceededErrorScopeUser,
			wantAvail:    512 * 1024,
			wantRequired: 2 * 1024 * 1024,
			wantSubstrs:  []string{"个人存储配额", "512 KB", "2 MB"},
		},
		{
			name: "organization unallocated pool exceeded",
			decision: quota.WriteDecision{
				Allowed:             false,
				Scope:               quota.ScopeOrganizationPool,
				ConstrainingOrgID:   2,
				ConstrainingOrgName: "研发部",
				RequiredBytes:       1024,
				AvailableBytes:      int64Ptr(0),
			},
			wantScope:    api.QuotaExceededErrorScopeOrganizationPool,
			wantOrgName:  "研发部",
			wantAvail:    0,
			wantRequired: 1024,
			wantSubstrs:  []string{"研发部", "未分配配额池", "0 B", "1 KB"},
		},
		{
			name: "organization total ceiling exceeded",
			decision: quota.WriteDecision{
				Allowed:             false,
				Scope:               quota.ScopeOrganizationTotal,
				ConstrainingOrgID:   1,
				ConstrainingOrgName: "总公司",
				RequiredBytes:       3 * 1024 * 1024,
				AvailableBytes:      int64Ptr(1024 * 1024),
			},
			wantScope:    api.QuotaExceededErrorScopeOrganizationTotal,
			wantOrgName:  "总公司",
			wantAvail:    1024 * 1024,
			wantRequired: 3 * 1024 * 1024,
			wantSubstrs:  []string{"总公司", "总存储配额", "1 MB", "3 MB"},
		},
		{
			name: "edit open precheck user quota exhausted",
			decision: quota.WriteDecision{
				Allowed:        false,
				Scope:          quota.ScopeUser,
				RequiredBytes:  0,
				AvailableBytes: int64Ptr(0),
			},
			wantScope:    api.QuotaExceededErrorScopeUser,
			wantAvail:    0,
			wantRequired: 0,
			wantSubstrs:  []string{"个人存储配额不足", "0 B"},
		},
		{
			name: "edit open precheck organization pool exhausted",
			decision: quota.WriteDecision{
				Allowed:             false,
				Scope:               quota.ScopeOrganizationPool,
				ConstrainingOrgID:   2,
				ConstrainingOrgName: "研发部",
				RequiredBytes:       0,
				AvailableBytes:      int64Ptr(0),
			},
			wantScope:    api.QuotaExceededErrorScopeOrganizationPool,
			wantOrgName:  "研发部",
			wantAvail:    0,
			wantRequired: 0,
			wantSubstrs:  []string{"研发部", "未分配配额池空间不足", "0 B"},
		},
		{
			name: "edit open precheck organization total exhausted",
			decision: quota.WriteDecision{
				Allowed:             false,
				Scope:               quota.ScopeOrganizationTotal,
				ConstrainingOrgID:   1,
				ConstrainingOrgName: "总公司",
				RequiredBytes:       0,
				AvailableBytes:      int64Ptr(0),
			},
			wantScope:    api.QuotaExceededErrorScopeOrganizationTotal,
			wantOrgName:  "总公司",
			wantAvail:    0,
			wantRequired: 0,
			wantSubstrs:  []string{"总公司", "总存储配额不足", "0 B"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := quotaExceededResponse(tc.decision)
			if resp.Code != api.QuotaExceededErrorCodeQuotaExceeded {
				t.Fatalf("code = %q, want %q", resp.Code, api.QuotaExceededErrorCodeQuotaExceeded)
			}
			if resp.Scope != tc.wantScope {
				t.Fatalf("scope = %q, want %q", resp.Scope, tc.wantScope)
			}
			if resp.AvailableBytes != tc.wantAvail {
				t.Fatalf("availableBytes = %d, want %d", resp.AvailableBytes, tc.wantAvail)
			}
			if resp.RequiredBytes != tc.wantRequired {
				t.Fatalf("requiredBytes = %d, want %d", resp.RequiredBytes, tc.wantRequired)
			}
			if tc.wantOrgName == "" {
				if resp.OrganizationName != nil {
					t.Fatalf("organizationName = %q, want nil", *resp.OrganizationName)
				}
			} else if resp.OrganizationName == nil || *resp.OrganizationName != tc.wantOrgName {
				t.Fatalf("organizationName = %v, want %q", resp.OrganizationName, tc.wantOrgName)
			}
			for _, sub := range tc.wantSubstrs {
				if !strings.Contains(resp.Message, sub) {
					t.Fatalf("message %q missing expected substring %q", resp.Message, sub)
				}
			}
		})
	}
}
