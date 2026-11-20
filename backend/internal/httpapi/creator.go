package httpapi

import (
	"context"

	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/permission"
	"github.com/liumingjian/ftp-master/backend/internal/tree"
)

func parentGrant(snap *tree.Snapshot, id int64) bool {
	n, ok := snap.Node(id)
	return ok && (snap.User.Administrator || n.ParentID.Valid && snap.Permission(n.ParentID.Int64).Rights.Has(permission.GrantRight))
}

// Resolve every intended member against the original snapshot. The draft must
// not bootstrap its own audience through a newly added file Grant.
func checkSharingAudience(ctx context.Context, q *sqlcdb.Queries, snap *tree.Snapshot, parent int64, kind string, principal int64) error {
	users, err := q.ListManagedUsers(ctx)
	if err != nil {
		return err
	}
	for _, u := range users {
		m, err := q.GetPermissionMembership(ctx, u.ID)
		if err != nil {
			return err
		}
		user := permission.User{ID: u.ID, OrganizationIDs: m.OrganizationIds, UserGroupIDs: m.UserGroupIds}
		match := permission.Evaluate(user, []permission.Node{{Grants: []permission.Grant{{Principal: permission.Principal{Kind: permission.PrincipalKind(kind), ID: principal}, Rights: permission.Browse}}}}, nil)
		if match.Rights == 0 {
			continue
		}
		view := *snap
		user.Administrator = u.IsAdministrator
		user.Deactivated = u.Status != "active"
		view.User = user
		if !view.Visible(parent) {
			return membershipFailure{403, "sharing audience must already see the parent directory"}
		}
	}
	return nil
}
