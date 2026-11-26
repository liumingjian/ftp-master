package httpapi

import (
	"context"
	"errors"
	"net/http"
	"path"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/db"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/permission"
	"github.com/liumingjian/ftp-master/backend/internal/recycle"
	"github.com/minio/minio-go/v7"
)

func (s *Server) InitiateUploadBatch(ctx context.Context, r api.InitiateUploadBatchRequestObject) (api.InitiateUploadBatchResponseObject, error) {
	if r.Body == nil || len(r.Body.Files) > 10000 || !validUploadPath(r.Body.Name) || strings.Contains(r.Body.Name, "/") {
		return membershipFailure{400, "invalid folder manifest"}, nil
	}
	policy, err := s.uploadPolicy(ctx)
	if err != nil {
		return nil, err
	}
	files := map[string]bool{}
	dirs := map[string]bool{}
	var totalSize int64
	for _, f := range r.Body.Files {
		if !validUploadPath(f.Path) || files[f.Path] || f.Size < 0 || f.Size > 20000000000 {
			return membershipFailure{400, "invalid folder manifest"}, nil
		}
		ext := strings.ToLower(strings.TrimPrefix(path.Ext(f.Path), "."))
		for _, blocked := range policy.BlockedExtensions {
			if ext == blocked {
				return membershipFailure{400, "blocked extension: " + ext}, nil
			}
		}
		files[f.Path] = true
		totalSize += f.Size
		for d := path.Dir(f.Path); d != "."; d = path.Dir(d) {
			dirs[d] = true
		}
	}
	if r.Body.Directories != nil {
		if len(*r.Body.Directories) > 10000 {
			return membershipFailure{400, "invalid folder manifest"}, nil
		}
		for _, d := range *r.Body.Directories {
			if !validUploadPath(d) {
				return membershipFailure{400, "invalid folder manifest"}, nil
			}
			dirs[d] = true
			for parent := path.Dir(d); parent != "."; parent = path.Dir(parent) {
				dirs[parent] = true
			}
		}
	}
	for d := range dirs {
		if files[d] {
			return membershipFailure{400, "file conflicts with directory"}, nil
		}
	}
	tx, err := s.membership.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err = lockMembershipAndTree(ctx, tx); err != nil {
		return nil, err
	}
	q := sqlcdb.New(tx)
	snap, err := s.treeSnapshot(ctx, q)
	if err != nil {
		return nil, err
	}
	if err = treeAccess(snap, r.Body.ParentId, permission.Upload); err != nil {
		f, e := membershipError(err)
		return f, e
	}
	parent, _ := snap.Node(r.Body.ParentId)
	if parent.IsFile {
		return membershipFailure{409, "destination must be a directory"}, nil
	}
	info := requestFrom(ctx)
	decision, err := checkWriteQuota(ctx, q, info.session.User.ID, totalSize)
	if err != nil {
		return nil, err
	}
	if !decision.Allowed {
		batchPath := snap.Path(r.Body.ParentId) + "/" + r.Body.Name
		_ = tx.Rollback(ctx)
		if err = s.recordQuotaExceededAudit(ctx, info, "upload", 0, batchPath, decision); err != nil {
			return nil, err
		}
		return api.InitiateUploadBatch507JSONResponse{QuotaExceededJSONResponse: quotaExceededResponse(decision)}, nil
	}
	root, err := q.CreateTreeNode(ctx, sqlcdb.CreateTreeNodeParams{ParentID: parentID(&r.Body.ParentId), Name: r.Body.Name})
	if err != nil {
		return membershipFailure{409, "folder name already exists"}, nil
	}
	id := opaqueKey()
	hasFiles := len(r.Body.Files) > 0
	if hasFiles {
		if err = q.CreateUploadBatch(ctx, sqlcdb.CreateUploadBatchParams{ID: id, OwnerID: requestFrom(ctx).session.User.ID, ParentID: r.Body.ParentId, RootID: root.ID, Expected: int32(len(r.Body.Files)), CreatedAt: pgtype.Timestamptz{Time: s.membership.Clock.Now(), Valid: true}}); err != nil {
			return nil, err
		}
		if err = q.HideUploadBatchNode(ctx, sqlcdb.HideUploadBatchNodeParams{NodeID: root.ID, BatchID: id}); err != nil {
			return nil, err
		}
	}
	names := make([]string, 0, len(dirs))
	for d := range dirs {
		names = append(names, d)
	}
	sort.Strings(names)
	parents := map[string]int64{".": root.ID}
	for _, d := range names {
		parent := parents[path.Dir(d)]
		node, e := q.CreateTreeNode(ctx, sqlcdb.CreateTreeNodeParams{ParentID: parentID(&parent), Name: path.Base(d)})
		if e != nil {
			return nil, e
		}
		parents[d] = node.ID
		if hasFiles {
			if err = q.HideUploadBatchNode(ctx, sqlcdb.HideUploadBatchNodeParams{NodeID: node.ID, BatchID: id}); err != nil {
				return nil, err
			}
		}
	}
	out := api.InitiateUploadBatch201JSONResponse{}
	core := minio.Core{Client: s.transfer.Client}
	committed := false
	type pending struct{ key, upload string }
	var pendingUploads []pending
	defer func() {
		if !committed {
			for _, u := range pendingUploads {
				_ = core.AbortMultipartUpload(context.WithoutCancel(ctx), s.transfer.Bucket, u.key, u.upload)
			}
		}
	}()
	for _, f := range r.Body.Files {
		sid, key := opaqueKey(), opaqueKey()
		upload, e := core.NewMultipartUpload(ctx, s.transfer.Bucket, key, minio.PutObjectOptions{UserMetadata: map[string]string{"upload-intent": sid}})
		if e != nil {
			return nil, e
		}
		pendingUploads = append(pendingUploads, pending{key, upload})
		count := int32((f.Size + uploadPartSize - 1) / uploadPartSize)
		if count == 0 {
			count = 1
		}
		if err = q.CreateUploadSession(ctx, sqlcdb.CreateUploadSessionParams{ID: sid, OwnerID: requestFrom(ctx).session.User.ID, ParentID: r.Body.ParentId, Name: path.Base(f.Path), Size: f.Size, ObjectKey: key, StorageUploadID: upload, PartSize: uploadPartSize, PartCount: count, CreatedAt: pgtype.Timestamptz{Time: s.membership.Clock.Now(), Valid: true}}); err != nil {
			return nil, err
		}
		if err = q.AttachUploadBatch(ctx, sqlcdb.AttachUploadBatchParams{ID: sid, BatchID: pgtype.Text{String: id, Valid: true}, RelativePath: f.Path}); err != nil {
			return nil, err
		}
		batchID := id
		out = append(out, api.UploadSession{Id: sid, PartCount: int(count), PartSize: uploadPartSize, BatchId: &batchID})
	}
	if !hasFiles {
		if _, err = q.CreateGrant(ctx, sqlcdb.CreateGrantParams{NodeID: root.ID, PrincipalKind: "user", PrincipalID: requestFrom(ctx).session.User.ID, Rights: 63, Scope: "subtree", Creator: true}); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	committed = true
	return out, nil
}
func validUploadPath(value string) bool {
	if value == "" || strings.ContainsAny(value, "\\\x00") || strings.HasPrefix(value, "/") {
		return false
	}
	for _, p := range strings.Split(value, "/") {
		if p == "" || p == "." || p == ".." || len(p) > 255 || strings.HasSuffix(p, ".") || strings.HasSuffix(p, " ") {
			return false
		}
	}
	return true
}
func (e membershipFailure) VisitInitiateUploadBatchResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (s *Server) CancelUploadBatch(ctx context.Context, r api.CancelUploadBatchRequestObject) (api.CancelUploadBatchResponseObject, error) {
	tx, err := s.membership.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// Serialize with upload publication and scheduler retention via the Shared Tree lock.
	if err = db.LockSharedTreeTx(ctx, tx); err != nil {
		return nil, err
	}
	q := sqlcdb.New(tx)
	batch, err := q.GetUploadBatchForUpdate(ctx, r.Id)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && batch.OwnerID != requestFrom(ctx).session.User.ID) {
		return membershipFailure{http.StatusNotFound, "upload batch not found"}, nil
	}
	if err != nil {
		return nil, err
	}
	hiddenNodes, err := q.ListUploadBatchNodeIDs(ctx, batch.ID)
	if err != nil {
		return nil, err
	}
	// RevealUploadBatch clears upload_batch_nodes while leaving upload_batches until 24h cleanup.
	if len(hiddenNodes) == 0 {
		return membershipFailure{http.StatusConflict, "upload batch already completed"}, nil
	}
	batchRef := pgtype.Text{String: batch.ID, Valid: true}
	for _, step := range []func() error{
		func() error { return q.QueueUploadBatchSessions(ctx, batchRef) },
		func() error { return q.QueueUploadBatchVersions(ctx, batch.ID) },
		func() error { return q.DeleteUploadBatchSessions(ctx, batchRef) },
		func() error { return q.DeleteUploadBatchVersions(ctx, batch.ID) },
		func() error { return q.DeleteUploadBatchNodes(ctx, batch.ID) },
		func() error { return q.DeleteUploadBatch(ctx, batch.ID) },
		func() error { return q.DeleteTreeNodesByIDs(ctx, hiddenNodes) },
	} {
		if err = step(); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	// Best-effort collection; durable storage_gc work retries on failure.
	_ = recycle.Collect(ctx, s.membership.Pool, s.transfer.Client, s.transfer.Bucket)
	return api.CancelUploadBatch204Response{}, nil
}
func (e membershipFailure) VisitCancelUploadBatchResponse(w http.ResponseWriter) error {
	return e.write(w)
}
