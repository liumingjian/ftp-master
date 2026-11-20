package httpapi

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/permission"
	"net/http"
)

func (s *Server) ListFileVersions(ctx context.Context, r api.ListFileVersionsRequestObject) (api.ListFileVersionsResponseObject, error) {
	tx, err := s.membership.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(725010)"); err != nil {
		return nil, err
	}
	q := sqlcdb.New(tx)
	if _, _, err = s.fileAccess(ctx, q, r.Id, permission.Browse); err != nil {
		f, e := membershipError(err)
		return f, e
	}
	rows, err := q.ListFileVersions(ctx, r.Id)
	if err != nil {
		return nil, err
	}
	result := api.ListFileVersions200JSONResponse{}
	for _, v := range rows {
		result = append(result, api.FileVersion{Id: v.ID, Size: v.Size, Format: v.Format, CreatedBy: v.CreatedBy, Username: v.Username, CreatedAt: v.CreatedAt.Time})
	}
	return result, nil
}
func (s *Server) RestoreFileVersion(ctx context.Context, r api.RestoreFileVersionRequestObject) (api.RestoreFileVersionResponseObject, error) {
	tx, err := s.membership.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(725010)"); err != nil {
		return nil, err
	}
	q := sqlcdb.New(tx)
	_, snap, err := s.fileAccess(ctx, q, r.Id, permission.Modify)
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	if r.VersionId < 1 {
		return membershipFailure{400, "invalid version"}, nil
	}
	source, err := q.GetFileVersion(ctx, sqlcdb.GetFileVersionParams{FileID: r.Id, Column2: r.VersionId})
	if errors.Is(err, pgx.ErrNoRows) {
		return membershipFailure{404, "version not found"}, nil
	}
	if err != nil {
		return nil, err
	}
	info := requestFrom(ctx)
	v, err := q.CreateFileVersion(ctx, sqlcdb.CreateFileVersionParams{FileID: r.Id, ObjectKey: source.ObjectKey, Size: source.Size, Format: source.Format, CreatedBy: info.session.User.ID, CreatedAt: pgtype.Timestamptz{Time: s.membership.Clock.Now(), Valid: true}})
	if err != nil {
		return nil, err
	}
	err = audit.NewRecorder(q, s.membership.Clock).Record(ctx, audit.Event{UserID: info.session.User.ID, Username: info.session.User.Username, SourceIP: info.sourceIP, Action: "restore_version", Outcome: audit.OutcomeSuccess, ItemID: r.Id, ItemPath: snap.Path(r.Id), Detail: map[string]any{"sourceVersionId": source.ID, "versionId": v.ID}})
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return api.RestoreFileVersion201JSONResponse{FileId: r.Id, VersionId: v.ID}, nil
}
func (e membershipFailure) VisitListFileVersionsResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (e membershipFailure) VisitRestoreFileVersionResponse(w http.ResponseWriter) error {
	return e.write(w)
}
