package httpapi

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/permission"
	"github.com/liumingjian/ftp-master/backend/internal/tree"
	"net/http"
)

// Preview uses the save validator and the production evaluator, then rolls back
// every write. The tree lock keeps before/after views consistent with saves.
func (s *Server) PreviewGrantDraft(ctx context.Context, r api.PreviewGrantDraftRequestObject) (api.PreviewGrantDraftResponseObject, error) {
	result, err := s.previewGrantDraft(ctx, r)
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	return result, nil
}
func (s *Server) previewGrantDraft(ctx context.Context, r api.PreviewGrantDraftRequestObject) (api.PreviewGrantDraft200JSONResponse, error) {
	tx, err := s.membership.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return api.PreviewGrantDraft200JSONResponse{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(725010)"); err != nil {
		return api.PreviewGrantDraft200JSONResponse{}, err
	}
	q := sqlcdb.New(tx)
	before, err := s.treeSnapshot(ctx, q)
	if err != nil {
		return api.PreviewGrantDraft200JSONResponse{}, err
	}
	var body *api.SaveGrantDraftJSONRequestBody
	if r.Body != nil {
		body = &api.SaveGrantDraftJSONRequestBody{Add: r.Body.Add, Remove: r.Body.Remove}
	}
	if _, err = s.applyGrantDraft(ctx, q, before, r.Id, body, false); err != nil {
		return api.PreviewGrantDraft200JSONResponse{}, err
	}
	after, err := s.treeSnapshot(ctx, q)
	if err != nil {
		return api.PreviewGrantDraft200JSONResponse{}, err
	}
	out := api.PreviewGrantDraft200JSONResponse{Warnings: []string{}}
	changed := map[int64]bool{}
	for _, id := range body.Remove {
		changed[id] = true
	}
	old := map[int64]bool{}
	for _, g := range before.Grants {
		old[g.ID] = true
	}
	for _, g := range after.Grants {
		if !old[g.ID] {
			changed[g.ID] = true
		}
	}
	covered := map[int64]bool{}
	for _, n := range before.Nodes {
		for _, snap := range []*tree.Snapshot{before, after} {
			for _, source := range GrantSources(snap, n.ID) {
				if changed[source.Grant.Id] {
					covered[n.ID] = true
				}
			}
		}
	}
	out.CoveredItems = len(covered)
	users, err := q.ListManagedUsers(ctx)
	if err != nil {
		return out, err
	}
	memberships := []permission.User{}
	for _, u := range users {
		m, e := q.GetPermissionMembership(ctx, u.ID)
		if e != nil {
			return out, e
		}
		user := permission.User{ID: u.ID, Administrator: u.IsAdministrator, Deactivated: u.Status != "active", OrganizationIDs: m.OrganizationIds, UserGroupIDs: m.UserGroupIds}
		memberships = append(memberships, user)
		b, a := *before, *after
		b.User = user
		a.User = user
		for _, n := range before.Nodes {
			if b.Permission(n.ID).Rights != a.Permission(n.ID).Rights {
				out.ChangedUsers++
				break
			}
		}
	}
	if before.Permission(r.Id).Rights.Has(permission.GrantRight) && !after.Permission(r.Id).Rights.Has(permission.GrantRight) {
		out.Warnings = append(out.Warnings, "self_grant_loss")
	}
	// Defaults: at least 50 active Users and 100 covered items for an added subtree Grant.
	for _, g := range after.Grants {
		if old[g.ID] || g.Scope != "subtree" || g.PrincipalKind == "user" {
			continue
		}
		n, _ := after.Node(g.NodeID)
		if n.IsFile {
			continue
		}
		members, items := 0, 0
		for _, u := range memberships {
			if u.Deactivated {
				continue
			}
			u.Administrator = false
			if permission.Evaluate(u, []permission.Node{{Grants: []permission.Grant{{Principal: permission.Principal{Kind: permission.PrincipalKind(g.PrincipalKind), ID: g.PrincipalID}, Rights: permission.Browse}}}}, nil).Rights != 0 {
				members++
			}
		}
		for _, n := range after.Nodes {
			for _, source := range GrantSources(after, n.ID) {
				if source.Grant.Id == g.ID {
					items++
					break
				}
			}
		}
		if members >= 50 && items >= 100 {
			out.Warnings = append(out.Warnings, "broad_subtree_grant")
			break
		}
	}
	return out, nil
}
func (s *Server) InspectPermission(ctx context.Context, r api.InspectPermissionRequestObject) (api.InspectPermissionResponseObject, error) {
	actor := requestFrom(ctx).session.User
	id := actor.ID
	if r.Params.UserId != nil {
		id = *r.Params.UserId
	}
	if id != actor.ID && !actor.IsAdministrator {
		return membershipFailure{403, "Administrator required"}, nil
	}
	tx, err := s.membership.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	q := sqlcdb.New(tx)
	viewer, err := s.treeSnapshot(ctx, q)
	if err != nil {
		return nil, err
	}
	if err = treeAccess(viewer, r.Id, 0); err != nil {
		return err.(membershipFailure), nil
	}
	u, err := q.GetUser(ctx, id)
	if err != nil {
		return membershipFailure{404, "User not found"}, nil
	}
	snap, err := tree.Load(ctx, q, permission.User{ID: u.ID, Administrator: u.IsAdministrator, Deactivated: u.Status != "active"})
	if err != nil {
		return nil, err
	}
	result := snap.Permission(r.Id)
	sources := []api.SourcedGrant{}
	matching := snap.User
	matching.Administrator = false
	for _, source := range GrantSources(snap, r.Id) {
		g := source.Grant
		if permission.Evaluate(matching, []permission.Node{{Grants: []permission.Grant{{Principal: permission.Principal{Kind: permission.PrincipalKind(g.PrincipalKind), ID: g.PrincipalId}, Rights: permission.Rights(g.Rights)}}}}, nil).Rights != 0 {
			sources = append(sources, source)
		}
	}
	return api.InspectPermission200JSONResponse{UserId: id, Rights: int(result.Rights), Traversable: result.TraversableAncestor, Administrator: u.IsAdministrator && u.Status == "active", Sources: sources}, nil
}
func (e membershipFailure) VisitPreviewGrantDraftResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (e membershipFailure) VisitInspectPermissionResponse(w http.ResponseWriter) error {
	return e.write(w)
}
