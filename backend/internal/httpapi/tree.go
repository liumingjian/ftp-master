package httpapi

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	ids := make([]int64, 0, len(result))
	for _, n := range result {
		if n.IsFile && n.Rights&int(permission.Browse) != 0 {
			ids = append(ids, n.Id)
		}
	}
	versions, err := sqlcdb.New(s.membership.Pool).ListLatestTreeVersions(ctx, ids)
	if err != nil {
		return nil, err
	}
	byFile := make(map[int64]sqlcdb.ListLatestTreeVersionsRow, len(versions))
	for _, v := range versions {
		byFile[v.FileID] = v
	}
	for i := range result {
		if v, ok := byFile[result[i].Id]; ok {
			result[i].LatestVersion = &struct {
				Format string `json:"format"`
				Id     int64  `json:"id"`
				Size   int64  `json:"size"`
			}{Format: v.Format, Id: v.ID, Size: v.Size}
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
	oldPath := snap.Path(id)
	result, err := change(q, snap)
	if err != nil {
		var conflict *pgconn.PgError
		if errors.As(err, &conflict) && conflict.Code == "23505" {
			return nil, membershipFailure{409, "an item with this name already exists in the destination"}
		}
		return nil, err
	}
	info := requestFrom(ctx)
	if n, ok := result.(api.TreeNode); ok {
		id = n.Id
	}
	err = audit.NewRecorder(q, s.membership.Clock).Record(ctx, audit.Event{UserID: info.session.User.ID, Username: info.session.User.Username, SourceIP: info.sourceIP, ItemID: id, ItemPath: snap.Path(id), Action: audit.Action(action), Outcome: audit.OutcomeSuccess, Detail: map[string]any{"nodeId": id, "result": result, "oldPath": oldPath, "newPath": snap.Path(id)}})
	if err != nil {
		return nil, err
	}
	return result, tx.Commit(ctx)
}
func (s *Server) CreateDirectory(ctx context.Context, r api.CreateDirectoryRequestObject) (api.CreateDirectoryResponseObject, error) {
	result, err := s.changeTree(ctx, "directory_create", 0, func(q *sqlcdb.Queries, snap *tree.Snapshot) (any, error) {
		if r.Body == nil || !validTreeName(r.Body.Name) {
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
		return createGrant(ctx, q, snap, r.Id, r.Body)
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
		for _, g := range snap.Grants {
			if g.ID == r.GrantId && g.NodeID == r.Id && g.Creator && !parentGrant(snap, r.Id) {
				return nil, membershipFailure{403, "Creator Grant requires directory administration"}
			}
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

func createGrant(ctx context.Context, q *sqlcdb.Queries, snap *tree.Snapshot, id int64, body *api.TreeGrantInput) (any, error) {
	if err := treeAccess(snap, id, permission.GrantRight); err != nil {
		return nil, err
	}
	if body == nil || body.Rights < 1 || body.Rights > 63 || body.PrincipalId <= 0 {
		return nil, membershipFailure{400, "invalid Grant"}
	}
	kind := string(body.PrincipalKind)
	scope := string(body.Scope)
	if (kind != "user" && kind != "organization" && kind != "user_group") || (scope != "subtree" && scope != "this_level_only") {
		return nil, membershipFailure{400, "invalid principal or Scope"}
	}
	exists := false
	switch kind {
	case "user":
		_, e := q.GetUser(ctx, body.PrincipalId)
		exists = e == nil
	case "organization":
		rows, e := q.ListOrganizations(ctx)
		if e != nil {
			return nil, e
		}
		for _, v := range rows {
			exists = exists || v.ID == body.PrincipalId
		}
	case "user_group":
		_, e := q.GetUserGroup(ctx, body.PrincipalId)
		exists = e == nil
	}
	if !exists {
		return nil, membershipFailure{400, "principal not found"}
	}
	creator := body.Creator != nil && *body.Creator
	node, _ := snap.Node(id)
	if creator {
		if !node.IsFile || kind != "user" || permission.Rights(body.Rights).Coherent() != permission.All {
			return nil, membershipFailure{400, "Creator Grant requires a file, User and all Rights"}
		}
		if !parentGrant(snap, id) {
			return nil, membershipFailure{403, "Creator Grant requires directory administration"}
		}
	}
	if node.IsFile && !parentGrant(snap, id) {
		if err := checkSharingAudience(ctx, q, snap, node.ParentID.Int64, kind, body.PrincipalId); err != nil {
			return nil, err
		}
	}
	if !snap.User.Administrator {
		allowed := snap.Permission(id).Rights
		node, _ := snap.Node(id)
		if !node.IsFile && scope == "subtree" {
			allowed = 0
			for _, source := range GrantSources(snap, id) {
				g := source.Grant
				if string(g.Scope) != "subtree" {
					continue
				}
				resolved := permission.Evaluate(snap.User, []permission.Node{{Grants: []permission.Grant{{Principal: permission.Principal{Kind: permission.PrincipalKind(g.PrincipalKind), ID: g.PrincipalId}, Rights: permission.Rights(g.Rights), Scope: permission.Subtree}}}}, nil)
				allowed |= resolved.Rights
			}
		}
		if !allowed.Has(permission.Rights(body.Rights).Coherent()) {
			return nil, membershipFailure{403, "Grant exceeds delegated Rights or Scope"}
		}
	}
	if node.IsFile {
		scope = "subtree"
	}
	g, e := q.CreateGrant(ctx, sqlcdb.CreateGrantParams{NodeID: id, PrincipalKind: kind, PrincipalID: body.PrincipalId, Rights: int16(permission.Rights(body.Rights).Coherent()), Scope: scope, Creator: creator})
	return grantResponse(g), e
}

func validTreeName(name string) bool {
	return strings.TrimSpace(name) != "" && len([]rune(name)) <= 255 && !strings.ContainsAny(name, "/\\\x00") && name != "." && name != ".."
}
func (s *Server) RenameTreeNode(ctx context.Context, r api.RenameTreeNodeRequestObject) (api.RenameTreeNodeResponseObject, error) {
	out, err := s.changeTree(ctx, "rename", r.Id, func(q *sqlcdb.Queries, snap *tree.Snapshot) (any, error) {
		if err := treeAccess(snap, r.Id, permission.Modify); err != nil {
			return nil, err
		}
		if r.Body == nil || !validTreeName(r.Body.Name) {
			return nil, membershipFailure{400, "invalid name"}
		}
		n, err := q.RenameTreeNode(ctx, sqlcdb.RenameTreeNodeParams{ID: r.Id, Name: r.Body.Name})
		if err != nil {
			return nil, err
		}
		for i := range snap.Nodes {
			if snap.Nodes[i].ID == n.ID {
				snap.Nodes[i] = n
			}
		}
		return treeResponse(n, snap), nil
	})
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	return api.RenameTreeNode200JSONResponse(out.(api.TreeNode)), nil
}
func (s *Server) MoveTreeNode(ctx context.Context, r api.MoveTreeNodeRequestObject) (api.MoveTreeNodeResponseObject, error) {
	out, err := s.changeTree(ctx, "move", r.Id, func(q *sqlcdb.Queries, snap *tree.Snapshot) (any, error) {
		if err := treeAccess(snap, r.Id, 0); err != nil {
			return nil, err
		}
		if r.Body == nil {
			return nil, membershipFailure{400, "destination required"}
		}
		n, _ := snap.Node(r.Id)
		if n.ParentID.Valid {
			if err := treeAccess(snap, n.ParentID.Int64, permission.Delete); err != nil {
				return nil, err
			}
		} else if !snap.User.Administrator {
			return nil, membershipFailure{403, "Administrator required"}
		}
		if r.Body.ParentId == nil {
			if !snap.User.Administrator {
				return nil, membershipFailure{403, "Administrator required"}
			}
		} else {
			target := *r.Body.ParentId
			if err := treeAccess(snap, target, permission.Upload); err != nil {
				return nil, err
			}
			dest, _ := snap.Node(target)
			if dest.IsFile {
				return nil, membershipFailure{409, "destination is a file"}
			}
			for target != 0 {
				if target == r.Id {
					return nil, membershipFailure{409, "cannot move into own subtree"}
				}
				ancestor, ok := snap.Node(target)
				if !ok {
					break
				}
				target = ancestor.ParentID.Int64
			}
		}
		n, err := q.MoveTreeNode(ctx, sqlcdb.MoveTreeNodeParams{ID: r.Id, ParentID: parentID(r.Body.ParentId)})
		if err != nil {
			return nil, err
		}
		for i := range snap.Nodes {
			if snap.Nodes[i].ID == n.ID {
				snap.Nodes[i] = n
			}
		}
		return treeResponse(n, snap), nil
	})
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	return api.MoveTreeNode200JSONResponse(out.(api.TreeNode)), nil
}
func (e membershipFailure) VisitRenameTreeNodeResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (e membershipFailure) VisitMoveTreeNodeResponse(w http.ResponseWriter) error { return e.write(w) }
