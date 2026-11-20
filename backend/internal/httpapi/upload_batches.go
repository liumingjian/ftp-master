package httpapi

import (
	"context"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/permission"
	"net/http"
	"path"
	"strings"
)

func (s *Server) InitiateUploadBatch(ctx context.Context, r api.InitiateUploadBatchRequestObject) (api.InitiateUploadBatchResponseObject, error) {
	if r.Body == nil || len(r.Body.Files) == 0 || len(r.Body.Files) > 10000 || !validUploadPath(r.Body.Name) || strings.Contains(r.Body.Name, "/") {
		return membershipFailure{400, "invalid folder manifest"}, nil
	}
	seen := map[string]bool{}
	for _, f := range r.Body.Files {
		if !validUploadPath(f.Path) || seen[f.Path] {
			return membershipFailure{400, "invalid folder manifest"}, nil
		}
		seen[f.Path] = true
	}
	for value := range seen {
		for prefix := path.Dir(value); prefix != "."; prefix = path.Dir(prefix) {
			if seen[prefix] {
				return membershipFailure{400, "file conflicts with directory"}, nil
			}
		}
	}
	tx, err := s.membership.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(725010)"); err != nil {
		return nil, err
	}
	snap, err := s.treeSnapshot(ctx, sqlcdb.New(tx))
	if err != nil {
		return nil, err
	}
	if err = treeAccess(snap, r.Body.ParentId, permission.Upload); err != nil {
		f, e := membershipError(err)
		return f, e
	}
	id := opaqueKey()
	root, err := sqlcdb.New(tx).CreateTreeNode(ctx, sqlcdb.CreateTreeNodeParams{ParentID: parentID(&r.Body.ParentId), Name: r.Body.Name, IsFile: false})
	if err != nil {
		return membershipFailure{409, "folder name already exists"}, nil
	}
	_, err = tx.Exec(ctx, "INSERT INTO upload_batches(id,owner_id,parent_id,root_id,expected,created_at) VALUES($1,$2,$3,$4,$5,$6)", id, requestFrom(ctx).session.User.ID, r.Body.ParentId, root.ID, len(r.Body.Files), s.membership.Clock.Now())
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(ctx, "INSERT INTO upload_batch_nodes VALUES($1,$2)", root.ID, id)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	out := api.InitiateUploadBatch201JSONResponse{}
	for _, f := range r.Body.Files {
		result, e := s.InitiateUpload(ctx, api.InitiateUploadRequestObject{Body: &api.UploadInput{ParentId: r.Body.ParentId, Name: path.Base(f.Path), Size: f.Size}})
		if e != nil {
			return nil, e
		}
		session, ok := result.(api.InitiateUpload201JSONResponse)
		if !ok {
			failure := result.(membershipFailure)
			return failure, nil
		}
		_, e = s.membership.Pool.Exec(ctx, "UPDATE upload_sessions SET batch_id=$2,relative_path=$3 WHERE id=$1", session.Id, id, f.Path)
		if e != nil {
			return nil, e
		}
		out = append(out, api.UploadSession(session))
	}
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
