package httpapi

import (
	"context"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/permission"
	"github.com/liumingjian/ftp-master/backend/internal/tree"
	"net/http"
)

// GrantSources returns all assignments reaching an item, independently of the editor's membership.
// This view is shared by the draft editor and permission inspection.
func GrantSources(snap *tree.Snapshot, id int64) []api.SourcedGrant {
	out := []api.SourcedGrant{}
	target, _ := snap.Node(id)
	for current, distance := id, 0; current != 0; distance++ {
		n, ok := snap.Node(current)
		if !ok {
			break
		}
		for _, g := range snap.Grants {
			if g.NodeID != current {
				continue
			}
			if distance > 0 && g.Scope != "subtree" && !(g.Scope == "this_level_only" && distance == 1 && target.IsFile) {
				continue
			}
			out = append(out, api.SourcedGrant{Grant: grantResponse(g), SourceId: current, SourcePath: snap.Path(current), Inherited: distance > 0})
		}
		current = n.ParentID.Int64
	}
	return out
}
func (s *Server) GetGrantDraft(ctx context.Context, r api.GetGrantDraftRequestObject) (api.GetGrantDraftResponseObject, error) {
	snap, err := s.treeSnapshot(ctx, sqlcdb.New(s.membership.Pool))
	if err != nil {
		return nil, err
	}
	if err = treeAccess(snap, r.Id, permission.GrantRight); err != nil {
		return err.(membershipFailure), nil
	}
	return api.GetGrantDraft200JSONResponse(GrantSources(snap, r.Id)), nil
}
func (s *Server) SaveGrantDraft(ctx context.Context, r api.SaveGrantDraftRequestObject) (api.SaveGrantDraftResponseObject, error) {
	_, err := s.changeTree(ctx, "grant_change", r.Id, func(q *sqlcdb.Queries, snap *tree.Snapshot) (any, error) {
		return s.applyGrantDraft(ctx, q, snap, r.Id, r.Body, true)
	})
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	return api.SaveGrantDraft204Response{}, nil
}
func (e membershipFailure) VisitGetGrantDraftResponse(w http.ResponseWriter) error { return e.write(w) }
func (e membershipFailure) VisitSaveGrantDraftResponse(w http.ResponseWriter) error {
	return e.write(w)
}

func (s *Server) applyGrantDraft(ctx context.Context, q *sqlcdb.Queries, snap *tree.Snapshot, id int64, body *api.SaveGrantDraftJSONRequestBody, auditing bool) (any, error) {
	if err := treeAccess(snap, id, permission.GrantRight); err != nil {
		return nil, err
	}
	if body == nil || len(body.Add) > 100 || len(body.Remove) > 100 {
		return nil, membershipFailure{400, "invalid draft"}
	}
	info := requestFrom(ctx)
	record := func(detail any) error {
		if !auditing {
			return nil
		}
		return audit.NewRecorder(q, s.membership.Clock).Record(ctx, audit.Event{UserID: info.session.User.ID, Username: info.session.User.Username, SourceIP: info.sourceIP, ItemID: id, ItemPath: snap.Path(id), Action: audit.Action("grant_change"), Outcome: audit.OutcomeSuccess, Detail: map[string]any{"change": detail}})
	}
	// Authorize the complete draft against the original snapshot so self-revocation remains atomic.
	for _, removeID := range body.Remove {
		found := false
		for _, g := range snap.Grants {
			if g.ID == removeID && g.NodeID == id {
				found = true
				if g.Creator && !parentGrant(snap, id) {
					return nil, membershipFailure{403, "Creator Grant requires directory administration"}
				}
			}
		}
		if !found {
			return nil, membershipFailure{404, "direct Grant not found"}
		}
		count, e := q.DeleteGrant(ctx, sqlcdb.DeleteGrantParams{ID: removeID, NodeID: id})
		if e != nil {
			return nil, e
		}
		if count == 0 {
			return nil, membershipFailure{400, "duplicate removal"}
		}
		if e = record(map[string]any{"removed": removeID}); e != nil {
			return nil, e
		}
	}
	for _, input := range body.Add {
		value, e := createGrant(ctx, q, snap, id, &input)
		if e != nil {
			return nil, e
		}
		if e = record(value); e != nil {
			return nil, e
		}
	}
	return map[string]any{"added": len(body.Add), "removed": len(body.Remove)}, nil
}
