package httpapi

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/db"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/permission"
	"github.com/liumingjian/ftp-master/backend/internal/recycle"
	"github.com/liumingjian/ftp-master/backend/internal/tree"
	"net/http"
	"time"
)

func (s *Server) DeleteTreeNode(ctx context.Context, r api.DeleteTreeNodeRequestObject) (api.DeleteTreeNodeResponseObject, error) {
	_, err := s.changeTree(ctx, "delete", r.Id, func(q *sqlcdb.Queries, snap *tree.Snapshot) (any, error) {
		if err := treeAccess(snap, r.Id, permission.Delete); err != nil {
			return nil, err
		}
		n, _ := snap.Node(r.Id)
		now := pgtype.Timestamptz{Time: s.membership.Clock.Now(), Valid: true}
		if err := q.CreateRecycleEntry(ctx, sqlcdb.CreateRecycleEntryParams{NodeID: r.Id, OriginalParentID: n.ParentID, OriginalPath: snap.Path(r.Id), DeletedAt: now}); err != nil {
			return nil, err
		}
		if err := q.MarkRecycleSubtree(ctx, sqlcdb.MarkRecycleSubtreeParams{RootID: pgtype.Int8{Int64: r.Id, Valid: true}, DeletedAt: now}); err != nil {
			return nil, err
		}
		_, err := q.MoveTreeNode(ctx, sqlcdb.MoveTreeNodeParams{ID: r.Id})
		return nil, err
	})
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	return api.DeleteTreeNode204Response{}, nil
}

func recycleAllowed(snap *tree.Snapshot, e sqlcdb.RecycleEntry) bool {
	if snap.User.Administrator {
		return true
	}
	for _, g := range snap.Grants {
		if g.NodeID == e.NodeID && g.Creator && g.PrincipalKind == "user" && g.PrincipalID == snap.User.ID {
			return true
		}
	}
	return e.OriginalParentID.Valid && snap.Permission(e.OriginalParentID.Int64).Rights.Has(permission.Delete)
}
func (s *Server) recycleChange(ctx context.Context, id int64, action string, target *int64) error {
	tx, err := s.membership.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = db.LockSharedTreeTx(ctx, tx); err != nil {
		return err
	}
	q := sqlcdb.New(tx)
	snap, err := s.treeSnapshot(ctx, q)
	if err != nil {
		return err
	}
	e, err := q.GetRecycleEntry(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return membershipFailure{404, "not found"}
	}
	if err != nil {
		return err
	}
	if !recycleAllowed(snap, e) {
		return membershipFailure{404, "not found"}
	}
	if action == "purge" {
		if !snap.User.Administrator {
			return membershipFailure{403, "Administrator required"}
		}
		if err = recycle.Purge(ctx, q, id); err != nil {
			return err
		}
	} else {
		parent := e.OriginalParentID
		if target != nil {
			if !snap.User.Administrator {
				return membershipFailure{403, "Administrator required"}
			}
			parent = parentID(target)
		}
		if parent.Valid {
			n, ok := snap.Node(parent.Int64)
			if !ok || n.IsFile {
				return membershipFailure{409, "original parent unavailable; Administrator must choose a directory"}
			}
		} else if !snap.User.Administrator {
			return membershipFailure{403, "Administrator required"}
		}
		if _, err = q.MoveTreeNode(ctx, sqlcdb.MoveTreeNodeParams{ID: id, ParentID: parent}); err != nil {
			return err
		}
		if err = q.RestoreRecycleSubtree(ctx, pgtype.Int8{Int64: id, Valid: true}); err != nil {
			return recycleConflict(err)
		}
		if err = q.DeleteRecycleEntry(ctx, id); err != nil {
			return err
		}
	}
	path := e.OriginalPath
	if action == "restore" {
		after, loadErr := s.treeSnapshot(ctx, q)
		if loadErr != nil {
			return loadErr
		}
		path = after.Path(id)
	}
	info := requestFrom(ctx)
	if err = audit.NewRecorder(q, s.membership.Clock).Record(ctx, audit.Event{UserID: info.session.User.ID, Username: info.session.User.Username, SourceIP: info.sourceIP, ItemID: id, ItemPath: path, Action: audit.Action(action), Outcome: audit.OutcomeSuccess}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func recycleConflict(err error) error {
	var conflict *pgconn.PgError
	if errors.As(err, &conflict) && conflict.Code == "23505" {
		return membershipFailure{409, "destination name conflict"}
	}
	return err
}
func (s *Server) RestoreTreeNode(ctx context.Context, r api.RestoreTreeNodeRequestObject) (api.RestoreTreeNodeResponseObject, error) {
	if r.Body == nil {
		return membershipFailure{400, "body required"}, nil
	}
	err := s.recycleChange(ctx, r.Id, "restore", r.Body.ParentId)
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	return api.RestoreTreeNode204Response{}, nil
}
func (s *Server) PurgeTreeNode(ctx context.Context, r api.PurgeTreeNodeRequestObject) (api.PurgeTreeNodeResponseObject, error) {
	err := s.recycleChange(ctx, r.Id, "purge", nil)
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	// GC failure leaves durable work for a later retry or scheduler run.
	_ = recycle.Collect(ctx, s.membership.Pool, s.transfer.Client, s.transfer.Bucket)
	return api.PurgeTreeNode204Response{}, nil
}
func (e membershipFailure) VisitDeleteTreeNodeResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (e membershipFailure) VisitRestoreTreeNodeResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (e membershipFailure) VisitPurgeTreeNodeResponse(w http.ResponseWriter) error { return e.write(w) }

func (s *Server) ListRecycleBin(ctx context.Context, _ api.ListRecycleBinRequestObject) (api.ListRecycleBinResponseObject, error) {
	q := sqlcdb.New(s.membership.Pool)
	snap, err := s.treeSnapshot(ctx, q)
	if err != nil {
		return nil, err
	}
	entries, err := q.ListRecycleEntries(ctx)
	if err != nil {
		return nil, err
	}
	out := api.ListRecycleBin200JSONResponse{}
	for _, e := range entries {
		if recycleAllowed(snap, e) {
			out = append(out, struct {
				DeletedAt    time.Time `json:"deletedAt"`
				Id           int64     `json:"id"`
				OriginalPath string    `json:"originalPath"`
			}{e.DeletedAt.Time, e.NodeID, e.OriginalPath})
		}
	}
	return out, nil
}
func (e membershipFailure) VisitListRecycleBinResponse(w http.ResponseWriter) error {
	return e.write(w)
}
