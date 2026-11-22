// Package tree loads Shared Tree metadata and resolves access through permission.Evaluate.
package tree

import (
	"context"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/permission"
)

// Snapshot is a consistent view loaded inside the caller's transaction.
type Snapshot struct {
	Nodes  []sqlcdb.TreeNode
	Grants []sqlcdb.Grant
	User   permission.User
}

func Load(ctx context.Context, q *sqlcdb.Queries, user permission.User) (*Snapshot, error) {
	nodes, err := q.ListTreeNodes(ctx)
	if err != nil {
		return nil, err
	}
	grants, err := q.ListGrants(ctx)
	if err != nil {
		return nil, err
	}
	membership, err := q.GetPermissionMembership(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	user.OrganizationIDs = membership.OrganizationIds
	user.UserGroupIDs = membership.UserGroupIds
	return &Snapshot{nodes, grants, user}, nil
}
func (s *Snapshot) Node(id int64) (sqlcdb.TreeNode, bool) {
	for _, n := range s.Nodes {
		if n.ID == id {
			return n, true
		}
	}
	return sqlcdb.TreeNode{}, false
}
func grant(g sqlcdb.Grant) permission.Grant {
	return permission.Grant{Principal: permission.Principal{Kind: permission.PrincipalKind(g.PrincipalKind), ID: g.PrincipalID}, Rights: permission.Rights(g.Rights), Scope: permission.Scope(g.Scope)}
}
func (s *Snapshot) below(id, ancestor int64) bool {
	for id != 0 {
		n, ok := s.Node(id)
		if !ok {
			return false
		}
		id = n.ParentID.Int64
		if id == ancestor {
			return true
		}
	}
	return false
}
func (s *Snapshot) Permission(id int64) permission.Result {
	var chain []permission.Node
	for current := id; current != 0; {
		n, ok := s.Node(current)
		if !ok {
			return permission.Result{}
		}
		p := permission.Node{IsFile: n.IsFile}
		for _, g := range s.Grants {
			if g.NodeID == current {
				p.Grants = append(p.Grants, grant(g))
			}
		}
		chain = append([]permission.Node{p}, chain...)
		current = n.ParentID.Int64
	}
	var descendants []permission.Grant
	for _, g := range s.Grants {
		if s.below(g.NodeID, id) {
			descendants = append(descendants, grant(g))
		}
	}
	return permission.Evaluate(s.User, chain, descendants)
}

// Visible includes Drop Boxes and Traversable Ancestors without granting Browse.
func (s *Snapshot) Visible(id int64) bool {
	r := s.Permission(id)
	n, ok := s.Node(id)
	return ok && (r.Rights.Has(permission.Browse) || r.TraversableAncestor || (!n.IsFile && r.Rights.Has(permission.Upload) && s.NavigationVisible(id)))
}

// NavigationVisible selects explicitly accessible paths inside a directory without Browse.
// Inherited Upload must never reveal the contents of a Drop Box.
func (s *Snapshot) NavigationVisible(id int64) bool {
	n, ok := s.Node(id)
	if !ok {
		return false
	}
	var direct, desc []permission.Grant
	for _, g := range s.Grants {
		if g.NodeID == id {
			direct = append(direct, grant(g))
		} else if s.below(g.NodeID, id) {
			desc = append(desc, grant(g))
		}
	}
	r := permission.Evaluate(s.User, []permission.Node{{IsFile: n.IsFile, Grants: direct}}, desc)
	return r.Rights != 0 || r.TraversableAncestor
}

// Path returns the current display path; stable IDs remain the source of identity.
func (s *Snapshot) Path(id int64) string {
	path := ""
	for id != 0 {
		n, ok := s.Node(id)
		if !ok {
			break
		}
		path = "/" + n.Name + path
		id = n.ParentID.Int64
	}
	return path
}
