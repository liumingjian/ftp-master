package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/db"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/permission"
)

func (s *Server) StartOfficeEdit(ctx context.Context, r api.StartOfficeEditRequestObject) (api.StartOfficeEditResponseObject, error) {
	if r.Body == nil {
		return membershipFailure{400, "edit request required"}, nil
	}
	var versionID int64
	if r.Body.VersionId != nil {
		versionID = *r.Body.VersionId
		if versionID < 1 {
			return membershipFailure{400, "invalid version"}, nil
		}
	}
	preview := r.Body.Preview != nil && *r.Body.Preview
	tx, err := s.membership.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// Serialize against membership/quota and tree/grant mutations in canonical lock order.
	if preview {
		if err = db.LockSharedTreeTx(ctx, tx); err != nil {
			return nil, err
		}
	} else {
		if err = lockMembershipAndTree(ctx, tx); err != nil {
			return nil, err
		}
	}
	q := sqlcdb.New(tx)
	snap, err := s.treeSnapshot(ctx, q)
	if err != nil {
		return nil, err
	}
	right := permission.Modify
	if preview {
		right = permission.Browse
	}
	if !preview {
		enabled, err := q.LockOfficeEditEnabled(ctx)
		if err != nil {
			return nil, err
		}
		if !enabled {
			return membershipFailure{403, "Office editing disabled"}, nil
		}
	}
	if err = treeAccess(snap, r.Id, right); err != nil {
		f, e := membershipError(err)
		return f, e
	}
	node, _ := snap.Node(r.Id)
	if !node.IsFile {
		return membershipFailure{409, "item is not a file"}, nil
	}
	version, err := q.GetFileVersion(ctx, sqlcdb.GetFileVersionParams{FileID: r.Id, Column2: versionID})
	if errors.Is(err, pgx.ErrNoRows) {
		return membershipFailure{404, "file version not found"}, nil
	}
	if err != nil {
		return nil, err
	}
	switch version.Format {
	case "doc", "docx", "wps", "xls", "xlsx":
	default:
		return membershipFailure{415, "unsupported Office format"}, nil
	}
	if version.Size > 25*1024*1024 {
		return membershipFailure{413, "Office file exceeds 25 MiB"}, nil
	}
	info := requestFrom(ctx)
	var availableQuotaBytes *int64
	if !preview {
		decision, err := checkEditOpenQuota(ctx, q, info.session.User.ID)
		if err != nil {
			return nil, err
		}
		if !decision.Allowed {
			return api.StartOfficeEdit507JSONResponse{QuotaExceededJSONResponse: quotaExceededResponse(decision)}, nil
		}
		availableQuotaBytes = decision.AvailableBytes
	}
	now := s.membership.Clock.Now()
	expires := now.Add(5 * time.Minute)
	id := opaqueKey()
	err = q.CreateOfficePermit(ctx, sqlcdb.CreateOfficePermitParams{ID: id, UserID: info.session.User.ID, FileID: r.Id, VersionID: version.ID, Preview: preview, CreatedAt: pgtype.Timestamptz{Time: now, Valid: true}, ExpiresAt: pgtype.Timestamptz{Time: expires, Valid: true}})
	if err != nil {
		return nil, err
	}
	base := BasePath + "/office/permits/" + id
	var saveURL *string
	if !preview {
		url := base + "/save"
		saveURL = &url
		err = audit.NewRecorder(q, s.membership.Clock).Record(ctx, audit.Event{UserID: info.session.User.ID, Username: info.session.User.Username, SourceIP: info.sourceIP, Action: "open_for_edit", Outcome: audit.OutcomeSuccess, ItemID: r.Id, ItemPath: snap.Path(r.Id), Detail: map[string]any{"versionId": version.ID, "permitId": id}})
		if err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return api.StartOfficeEdit201JSONResponse{PermitId: id, DocumentUrl: base + "/document/" + url.PathEscape(node.Name), SaveUrl: saveURL, DeliveryCheckUrl: base + "/delivery", Title: node.Name, Format: api.OfficeEditFormat(version.Format), ExpiresAt: expires, VersionId: version.ID, AvailableQuotaBytes: availableQuotaBytes}, nil
}
func (e membershipFailure) VisitStartOfficeEditResponse(w http.ResponseWriter) error {
	return e.write(w)
}
