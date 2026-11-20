package permission_test

import (
	"github.com/liumingjian/ftp-master/backend/internal/permission"
	"testing"
)

func TestEffectivePermissionMatchesPrincipalsAndUnionsRights(t *testing.T) {
	user := permission.User{ID: 1, OrganizationIDs: []int64{2, 3}, UserGroupIDs: []int64{4}}
	for _, tc := range []struct {
		name      string
		principal permission.Principal
		want      permission.Rights
	}{
		{"user", permission.Principal{Kind: permission.UserPrincipal, ID: 1}, permission.Upload},
		{"organization", permission.Principal{Kind: permission.OrganizationPrincipal, ID: 2}, permission.Upload},
		{"ancestor organization", permission.Principal{Kind: permission.OrganizationPrincipal, ID: 3}, permission.Upload},
		{"user group", permission.Principal{Kind: permission.UserGroupPrincipal, ID: 4}, permission.Upload},
		{"unrelated user", permission.Principal{Kind: permission.UserPrincipal, ID: 5}, 0},
		{"same id different principal", permission.Principal{Kind: permission.UserGroupPrincipal, ID: 1}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := permission.Evaluate(user, []permission.Node{{Grants: []permission.Grant{{Principal: tc.principal, Rights: permission.Upload}}}, {}, {IsFile: true}}, nil)
			if got.Rights != tc.want {
				t.Fatalf("rights = %v, want %v", got.Rights, tc.want)
			}
		})
	}
	got := permission.Evaluate(user, []permission.Node{{Grants: []permission.Grant{{Principal: permission.Principal{Kind: permission.UserPrincipal, ID: 1}, Rights: permission.Upload}}}, {Grants: []permission.Grant{{Principal: permission.Principal{Kind: permission.OrganizationPrincipal, ID: 3}, Rights: permission.Download}}}}, nil)
	if got.Rights != permission.Browse|permission.Download|permission.Upload {
		t.Fatalf("union rights = %v", got.Rights)
	}
}

func TestGrantScopeAcrossTreeDepths(t *testing.T) {
	user := permission.User{ID: 1}
	for _, tc := range []struct {
		name  string
		scope permission.Scope
		depth int
		file  bool
		want  permission.Rights
	}{
		{"subtree directory", permission.Subtree, 3, false, permission.Upload},
		{"subtree file", permission.Subtree, 4, true, permission.Upload},
		{"default subtree", "", 3, true, permission.Upload},
		{"this directory", permission.ThisLevelOnly, 0, false, permission.Upload},
		{"direct file", permission.ThisLevelOnly, 1, true, permission.Upload},
		{"direct subdirectory", permission.ThisLevelOnly, 1, false, 0},
		{"nested file", permission.ThisLevelOnly, 2, true, 0},
		{"nested directory", permission.ThisLevelOnly, 2, false, 0},
		{"unknown ancestor scope", permission.Scope("invalid"), 1, true, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			chain := make([]permission.Node, tc.depth+1)
			chain[0].Grants = []permission.Grant{{Principal: permission.Principal{Kind: permission.UserPrincipal, ID: 1}, Rights: permission.Upload, Scope: tc.scope}}
			chain[tc.depth].IsFile = tc.file
			got := permission.Evaluate(user, chain, nil)
			if got.Rights != tc.want {
				t.Fatalf("rights = %v, want %v", got.Rights, tc.want)
			}
		})
	}
}

func TestRightDependenciesAndCreatorGrant(t *testing.T) {
	for _, tc := range []struct {
		name         string
		rights, want permission.Rights
	}{
		{"browse", permission.Browse, permission.Browse},
		{"drop box", permission.Upload, permission.Upload},
		{"download", permission.Download, permission.Browse | permission.Download},
		{"modify", permission.Modify, permission.Browse | permission.Download | permission.Modify},
		{"delete", permission.Delete, permission.Browse | permission.Delete},
		{"grant", permission.GrantRight, permission.All},
		{"creator", permission.All, permission.All},
		{"unknown rights", permission.Rights(128), 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := permission.Evaluate(permission.User{ID: 1}, []permission.Node{{IsFile: true, Grants: []permission.Grant{{Principal: permission.Principal{Kind: permission.UserPrincipal, ID: 1}, Rights: tc.rights}}}}, nil)
			if got.Rights != tc.want {
				t.Fatalf("rights = %v, want %v", got.Rights, tc.want)
			}
		})
	}
}

func TestTraversableAncestorsNeverInheritDescendantRights(t *testing.T) {
	for _, tc := range []struct {
		name              string
		file              bool
		local, descendant permission.Rights
		principal         permission.Principal
		want              bool
	}{
		{"ancestor of directly granted file", false, 0, permission.Download, permission.Principal{Kind: permission.UserPrincipal, ID: 1}, true},
		{"ancestor of group grant", false, 0, permission.Upload, permission.Principal{Kind: permission.UserGroupPrincipal, ID: 4}, true},
		{"unrelated grant", false, 0, permission.Download, permission.Principal{Kind: permission.UserPrincipal, ID: 5}, false},
		{"empty grant", false, 0, 0, permission.Principal{Kind: permission.UserPrincipal, ID: 1}, false},
		{"file cannot be traversed", true, 0, permission.Download, permission.Principal{Kind: permission.UserPrincipal, ID: 1}, false},
		{"browse already granted", false, permission.Browse, permission.Download, permission.Principal{Kind: permission.UserPrincipal, ID: 1}, false},
		{"drop box with descendant access", false, permission.Upload, permission.Browse, permission.Principal{Kind: permission.UserPrincipal, ID: 1}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := permission.Evaluate(permission.User{ID: 1, UserGroupIDs: []int64{4}}, []permission.Node{{IsFile: tc.file, Grants: []permission.Grant{{Principal: permission.Principal{Kind: permission.UserPrincipal, ID: 1}, Rights: tc.local}}}}, []permission.Grant{{Principal: tc.principal, Rights: tc.descendant}})
			if got.Rights != tc.local || got.TraversableAncestor != tc.want {
				t.Fatalf("result = %+v, want rights %v, traversable %v", got, tc.local, tc.want)
			}
		})
	}
}

func TestAdministratorAndDeactivatedShortCircuit(t *testing.T) {
	for _, tc := range []struct {
		name                       string
		administrator, deactivated bool
		want                       permission.Rights
	}{
		{"administrator", true, false, permission.All},
		{"deactivated administrator", true, true, 0},
		{"deactivated user", false, true, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := permission.Evaluate(permission.User{ID: 1, Administrator: tc.administrator, Deactivated: tc.deactivated}, []permission.Node{{Grants: []permission.Grant{{Principal: permission.Principal{Kind: permission.UserPrincipal, ID: 1}, Rights: permission.All}}}}, []permission.Grant{{Principal: permission.Principal{Kind: permission.UserPrincipal, ID: 1}, Rights: permission.All}})
			if got.Rights != tc.want || got.TraversableAncestor {
				t.Fatalf("result = %+v, want rights %v without traversal", got, tc.want)
			}
		})
	}
	if got := permission.Evaluate(permission.User{ID: 1}, nil, nil); got != (permission.Result{}) {
		t.Fatalf("empty chain = %+v", got)
	}
}
