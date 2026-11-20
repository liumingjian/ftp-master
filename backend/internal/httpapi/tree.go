package httpapi

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/permission"
	"github.com/liumingjian/ftp-master/backend/internal/tree"
	"net/http"
	"strings"
)

func (s *Server) treeSnapshot(ctx context.Context, q *sqlcdb.Queries) (*tree.Snapshot, error) {
	u := requestFrom(ctx).session.User
	return tree.Load(ctx, q, permission.User{ID: u.ID, Administrator: u.IsAdministrator})
}
func treeResponse(n sqlcdb.TreeNode, s *tree.Snapshot) api.TreeNode {
	r := s.Permission(n.ID)
	return api.TreeNode{Id: n.ID, ParentId: nullableID(n.ParentID.Int64), Name: n.Name, IsFile: n.IsFile, Rights: int(r.Rights), Traversable: r.TraversableAncestor}
}
func nullableID(id int64) *int64 {
	if id == 0 {
		return nil
	}
	return &id
}
func treeAccess(s *tree.Snapshot, id int64, right permission.Rights) error {
	if _, ok := s.Node(id); !ok || !s.Visible(id) {
		return membershipFailure{404, "not found"}
	}
	if !s.Permission(id).Rights.Has(right) {
		return membershipFailure{403, "Right required"}
	}
	return nil
}
func (s *Server) ListTree(ctx context.Context, r api.ListTreeRequestObject) (api.ListTreeResponseObject, error) {
	snap, err := s.treeSnapshot(ctx, sqlcdb.New(s.membership.Pool))
	if err != nil {
		return nil, err
	}
	parent := int64(0)
	if r.Params.ParentId != nil {
		parent = *r.Params.ParentId
		if err := treeAccess(snap, parent, 0); err != nil {
			return err.(membershipFailure), nil
		}
	}
	result := api.ListTree200JSONResponse{}
	for _, n := range snap.Nodes {
		if n.ParentID.Int64 == parent && snap.Visible(n.ID) {
			if parent != 0 && !snap.Permission(parent).Rights.Has(permission.Browse) {
				if !snap.NavigationVisible(n.ID) {
					continue
				}
			}
			result = append(result, treeResponse(n, snap))
		}
	}
	return result, nil
}
func (s *Server) GetTreeNode(ctx context.Context, r api.GetTreeNodeRequestObject) (api.GetTreeNodeResponseObject, error) {
	snap, err := s.treeSnapshot(ctx, sqlcdb.New(s.membership.Pool))
	if err != nil {
		return nil, err
	}
	if err = treeAccess(snap, r.Id, 0); err != nil {
		return err.(membershipFailure), nil
	}
	n, _ := snap.Node(r.Id)
	return api.GetTreeNode200JSONResponse(treeResponse(n, snap)), nil
}

// Tree mutations serialize authorization, writes, and their Audit Event together.
func (s *Server) changeTree(ctx context.Context, action string, id int64, change func(*sqlcdb.Queries, *tree.Snapshot) (any, error)) (any, error) {
	tx, err := s.membership.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(725010)"); err != nil {
		return nil, err
	}
	q := sqlcdb.New(tx)
	snap, err := s.treeSnapshot(ctx, q)
	if err != nil {
		return nil, err
	}
	result, err := change(q, snap)
	if err != nil {
		return nil, err
	}
	info := requestFrom(ctx)
	if n, ok := result.(api.TreeNode); ok {
		id = n.Id
	}
	err = audit.NewRecorder(q, s.membership.Clock).Record(ctx, audit.Event{UserID: info.session.User.ID, Username: info.session.User.Username, SourceIP: info.sourceIP, ItemID: id, ItemPath: snap.Path(id), Action: audit.Action(action), Outcome: audit.OutcomeSuccess, Detail: map[string]any{"nodeId": id, "result": result}})
	if err != nil {
		return nil, err
	}
	return result, tx.Commit(ctx)
}
func (s *Server) CreateDirectory(ctx context.Context, r api.CreateDirectoryRequestObject) (api.CreateDirectoryResponseObject, error) {
	result, err := s.changeTree(ctx, "directory_create", 0, func(q *sqlcdb.Queries, snap *tree.Snapshot) (any, error) {
		if r.Body == nil || strings.TrimSpace(r.Body.Name) == "" || len(r.Body.Name) > 255 || strings.ContainsAny(r.Body.Name, "/\\") || r.Body.Name == "." || r.Body.Name == ".." {
			return nil, membershipFailure{400, "invalid name"}
		}
		if r.Body.ParentId == nil {
			if !snap.User.Administrator {
				return nil, membershipFailure{403, "Administrator required"}
			}
		} else {
			if err := treeAccess(snap, *r.Body.ParentId, permission.Upload); err != nil {
				return nil, err
			}
			n, _ := snap.Node(*r.Body.ParentId)
			if n.IsFile {
				return nil, membershipFailure{409, "parent is a file"}
			}
		}
		n, err := q.CreateTreeNode(ctx, sqlcdb.CreateTreeNodeParams{ParentID: parentID(r.Body.ParentId), Name: r.Body.Name})
		if err != nil {
			return nil, err
		}
		snap.Nodes = append(snap.Nodes, n)
		return treeResponse(n, snap), nil
	})
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	return api.CreateDirectory201JSONResponse(result.(api.TreeNode)), nil
}
func grantResponse(g sqlcdb.Grant) api.TreeGrant {
	return api.TreeGrant{Id: g.ID, Creator: g.Creator, PrincipalKind: api.TreeGrantPrincipalKind(g.PrincipalKind), PrincipalId: g.PrincipalID, Rights: int(g.Rights), Scope: api.TreeGrantScope(g.Scope)}
}
func (s *Server) ListTreeGrants(ctx context.Context, r api.ListTreeGrantsRequestObject) (api.ListTreeGrantsResponseObject, error) {
	snap, err := s.treeSnapshot(ctx, sqlcdb.New(s.membership.Pool))
	if err != nil {
		return nil, err
	}
	if err = treeAccess(snap, r.Id, permission.GrantRight); err != nil {
		return err.(membershipFailure), nil
	}
	out := api.ListTreeGrants200JSONResponse{}
	for _, g := range snap.Grants {
		if g.NodeID == r.Id {
			out = append(out, grantResponse(g))
		}
	}
	return out, nil
}
func (s *Server) CreateTreeGrant(ctx context.Context, r api.CreateTreeGrantRequestObject) (api.CreateTreeGrantResponseObject, error) {
	out, err := s.changeTree(ctx, "grant_change", r.Id, func(q *sqlcdb.Queries, snap *tree.Snapshot) (any, error) {
		if err := treeAccess(snap, r.Id, permission.GrantRight); err != nil {
			return nil, err
		}
		if r.Body == nil || r.Body.Rights < 1 || r.Body.Rights > 63 || r.Body.PrincipalId <= 0 {
			return nil, membershipFailure{400, "invalid Grant"}
		}
		kind := string(r.Body.PrincipalKind)
		scope := string(r.Body.Scope)
		if (kind != "user" && kind != "organization" && kind != "user_group") || (scope != "subtree" && scope != "this_level_only") {
			return nil, membershipFailure{400, "invalid principal or Scope"}
		}
		exists := false
		switch kind {
		case "user":
			_, e := q.GetUser(ctx, r.Body.PrincipalId)
			exists = e == nil
		case "organization":
			rows, e := q.ListOrganizations(ctx)
			if e != nil {
				return nil, e
			}
			for _, v := range rows {
				exists = exists || v.ID == r.Body.PrincipalId
			}
		case "user_group":
			_, e := q.GetUserGroup(ctx, r.Body.PrincipalId)
			exists = e == nil
		}
		if !exists {
			return nil, membershipFailure{400, "principal not found"}
		}
		g, e := q.CreateGrant(ctx, sqlcdb.CreateGrantParams{NodeID: r.Id, PrincipalKind: kind, PrincipalID: r.Body.PrincipalId, Rights: int16(permission.Rights(r.Body.Rights).Coherent()), Scope: scope})
		return grantResponse(g), e
	})
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	return api.CreateTreeGrant201JSONResponse(out.(api.TreeGrant)), nil
}
func (s *Server) DeleteTreeGrant(ctx context.Context, r api.DeleteTreeGrantRequestObject) (api.DeleteTreeGrantResponseObject, error) {
	_, err := s.changeTree(ctx, "grant_change", r.Id, func(q *sqlcdb.Queries, snap *tree.Snapshot) (any, error) {
		if err := treeAccess(snap, r.Id, permission.GrantRight); err != nil {
			return nil, err
		}
		n, e := q.DeleteGrant(ctx, sqlcdb.DeleteGrantParams{ID: r.GrantId, NodeID: r.Id})
		if e == nil && n == 0 {
			return nil, membershipFailure{404, "Grant not found"}
		}
		return map[string]any{"revoked": r.GrantId}, e
	})
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	return api.DeleteTreeGrant204Response{}, nil
}
func (e membershipFailure) VisitListTreeResponse(w http.ResponseWriter) error    { return e.write(w) }
func (e membershipFailure) VisitGetTreeNodeResponse(w http.ResponseWriter) error { return e.write(w) }
func (e membershipFailure) VisitCreateDirectoryResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (e membershipFailure) VisitListTreeGrantsResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (e membershipFailure) VisitCreateTreeGrantResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (e membershipFailure) VisitDeleteTreeGrantResponse(w http.ResponseWriter) error {
	return e.write(w)
}
