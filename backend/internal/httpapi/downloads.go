package httpapi

import (
	"context"
	"errors"
	"mime"
	"net/http"
	"net/url"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/permission"
	"github.com/liumingjian/ftp-master/backend/internal/tree"
)

// fileAccess applies the shared non-disclosing authorization rule before any version lookup.
func (s *Server) fileAccess(ctx context.Context, q *sqlcdb.Queries, id int64, right permission.Rights) (sqlcdb.TreeNode, *tree.Snapshot, error) {
	snap, err := s.treeSnapshot(ctx, q)
	if err != nil {
		return sqlcdb.TreeNode{}, nil, err
	}
	if err = treeAccess(snap, id, right); err != nil {
		return sqlcdb.TreeNode{}, snap, err
	}
	node, _ := snap.Node(id)
	if !node.IsFile {
		return node, snap, membershipFailure{409, "file required"}
	}
	return node, snap, nil
}

func (s *Server) DownloadFile(ctx context.Context, r api.DownloadFileRequestObject) (api.DownloadFileResponseObject, error) {
	tx, err := s.membership.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// Serialize capability issuance with permission and tree mutations.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(725010)"); err != nil {
		return nil, err
	}
	q := sqlcdb.New(tx)
	node, snap, err := s.fileAccess(ctx, q, r.Id, permission.Download)
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	var versionID int64
	if r.Params.VersionId != nil {
		versionID = *r.Params.VersionId
		if versionID < 1 {
			return membershipFailure{400, "invalid version"}, nil
		}
	}
	version, err := q.GetFileVersion(ctx, sqlcdb.GetFileVersionParams{FileID: r.Id, Column2: versionID})
	if errors.Is(err, pgx.ErrNoRows) {
		return membershipFailure{404, "version not found"}, nil
	}
	if err != nil {
		return nil, err
	}
	signed, err := s.transfer.Signer.PresignedGetObject(ctx, s.transfer.Bucket, version.ObjectKey, 15*time.Minute, url.Values{"response-content-disposition": {mime.FormatMediaType("attachment", map[string]string{"filename": node.Name})}, "response-content-type": {"application/octet-stream"}})
	if err != nil {
		return nil, err
	}
	info := requestFrom(ctx)
	err = audit.NewRecorder(q, s.membership.Clock).Record(ctx, audit.Event{UserID: info.session.User.ID, Username: info.session.User.Username, SourceIP: info.sourceIP, Action: "download", Outcome: audit.OutcomeSuccess, ItemID: r.Id, ItemPath: snap.Path(r.Id), Detail: map[string]any{"versionId": version.ID, "size": version.Size}})
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return api.DownloadFile302Response{Headers: api.DownloadFile302ResponseHeaders{Location: signed.String(), CacheControl: "no-store"}}, nil
}
func (e membershipFailure) VisitDownloadFileResponse(w http.ResponseWriter) error { return e.write(w) }
