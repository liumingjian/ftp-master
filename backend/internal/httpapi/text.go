package httpapi

import (
	"bytes"
	"context"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/permission"
	"github.com/minio/minio-go/v7"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"
)

const textLimit = 10000000

func editableText(format string) bool {
	switch strings.ToLower(format) {
	case "txt", "md", "csv", "json", "xml", "log", "yaml", "yml", "toml", "ini", "conf":
		return true
	}
	return false
}
func (e membershipFailure) VisitOpenTextResponse(w http.ResponseWriter) error { return e.write(w) }
func (e membershipFailure) VisitSaveTextResponse(w http.ResponseWriter) error { return e.write(w) }
func (s *Server) OpenText(ctx context.Context, r api.OpenTextRequestObject) (api.OpenTextResponseObject, error) {
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
	v, err := q.GetFileVersion(ctx, sqlcdb.GetFileVersionParams{FileID: r.Id})
	if err != nil {
		return nil, err
	}
	if !editableText(v.Format) {
		return membershipFailure{415, "plain text required"}, nil
	}
	if v.Size >= textLimit {
		return membershipFailure{413, "file must be under 10 MB"}, nil
	}
	obj, err := s.transfer.Client.GetObject(ctx, s.transfer.Bucket, v.ObjectKey, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer obj.Close()
	data, err := io.ReadAll(io.LimitReader(obj, textLimit))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != v.Size || !utf8.Valid(data) || bytes.ContainsRune(data, 0) {
		return membershipFailure{415, "valid UTF-8 plain text required"}, nil
	}
	info := requestFrom(ctx)
	if err = audit.NewRecorder(q, s.membership.Clock).Record(ctx, audit.Event{UserID: info.session.User.ID, Username: info.session.User.Username, SourceIP: info.sourceIP, Action: "text_open", Outcome: audit.OutcomeSuccess, ItemID: r.Id, ItemPath: snap.Path(r.Id), Detail: map[string]any{"versionId": v.ID}}); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return api.OpenText200JSONResponse{VersionId: v.ID, Content: string(data)}, nil
}
func (s *Server) SaveText(ctx context.Context, r api.SaveTextRequestObject) (api.SaveTextResponseObject, error) {
	if r.Body == nil {
		return membershipFailure{400, "body required"}, nil
	}
	data := []byte(r.Body.Content)
	if len(data) >= textLimit {
		return membershipFailure{413, "file must be under 10 MB"}, nil
	}
	if !utf8.Valid(data) || bytes.ContainsRune(data, 0) {
		return membershipFailure{415, "valid UTF-8 plain text required"}, nil
	}
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
	latest, err := q.GetFileVersion(ctx, sqlcdb.GetFileVersionParams{FileID: r.Id})
	if err != nil {
		return nil, err
	}
	if !editableText(latest.Format) {
		return membershipFailure{415, "plain text required"}, nil
	}
	if latest.Size >= textLimit {
		return membershipFailure{413, "file must be under 10 MB"}, nil
	}
	if latest.ID != r.Body.BaseVersionId {
		return membershipFailure{409, "file changed; reload and merge before saving"}, nil
	}
	key := opaqueKey()
	committed := false
	defer s.rollbackImmutableObject(ctx, key, &committed)()
	if err = s.writeImmutableObject(ctx, key, data, "text/plain; charset=utf-8"); err != nil {
		return nil, err
	}

	info := requestFrom(ctx)
	v, err := q.CreateFileVersion(ctx, sqlcdb.CreateFileVersionParams{FileID: r.Id, ObjectKey: key, Size: int64(len(data)), Format: latest.Format, CreatedBy: info.session.User.ID, CreatedAt: pgtype.Timestamptz{Time: s.membership.Clock.Now(), Valid: true}})
	if err != nil {
		return nil, err
	}
	if err = audit.NewRecorder(q, s.membership.Clock).Record(ctx, audit.Event{UserID: info.session.User.ID, Username: info.session.User.Username, SourceIP: info.sourceIP, Action: "text_save", Outcome: audit.OutcomeSuccess, ItemID: r.Id, ItemPath: snap.Path(r.Id), Detail: map[string]any{"versionId": v.ID, "baseVersionId": latest.ID}}); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	committed = true
	return api.SaveText201JSONResponse{FileId: r.Id, VersionId: v.ID}, nil
}
