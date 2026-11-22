package httpapi

import (
	"context"
	"errors"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/permission"
	"github.com/minio/minio-go/v7"
)

func (s *Server) SearchTree(ctx context.Context, r api.SearchTreeRequestObject) (api.SearchTreeResponseObject, error) {
	query := strings.TrimSpace(r.Params.Q)
	if query == "" || len([]rune(query)) > 255 {
		return membershipFailure{400, "invalid search"}, nil
	}
	snap, err := s.treeSnapshot(ctx, sqlcdb.New(s.membership.Pool))
	if err != nil {
		return nil, err
	}
	result := api.SearchTree200JSONResponse{}
	moveByParent := make(map[int64]bool)
	for _, n := range snap.Nodes {
		if n.IsFile && snap.Permission(n.ID).Rights.Has(permission.Browse) && strings.Contains(strings.ToLower(n.Name), strings.ToLower(query)) {
			entry := treeResponse(n, snap)
			parentID := n.ParentID.Int64
			canMove, checked := moveByParent[parentID]
			if !checked {
				canMove = checkMoveSource(snap, n) == nil
				moveByParent[parentID] = canMove
			}
			entry.CanMoveFromParent = &canMove
			result = append(result, entry)
		}
	}
	return result, s.attachLatestVersions(ctx, result)
}
func (e membershipFailure) VisitSearchTreeResponse(w http.ResponseWriter) error  { return e.write(w) }
func (e membershipFailure) VisitPreviewFileResponse(w http.ResponseWriter) error { return e.write(w) }

// Preview types are an explicit passive allowlist; HTML and SVG never execute on the application origin.
func previewType(format string) string {
	return map[string]string{"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "avif": "image/avif", "bmp": "image/bmp", "pdf": "application/pdf", "txt": "text/plain; charset=utf-8", "csv": "text/plain; charset=utf-8", "log": "text/plain; charset=utf-8", "md": "text/plain; charset=utf-8", "json": "text/plain; charset=utf-8", "xml": "text/plain; charset=utf-8", "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg", "m4a": "audio/mp4", "mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime"}[strings.ToLower(format)]
}
func (s *Server) PreviewFile(ctx context.Context, r api.PreviewFileRequestObject) (api.PreviewFileResponseObject, error) {
	q := sqlcdb.New(s.membership.Pool)
	node, _, err := s.fileAccess(ctx, q, r.Id, permission.Browse)
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	version, err := q.GetFileVersion(ctx, sqlcdb.GetFileVersionParams{FileID: r.Id})
	if errors.Is(err, pgx.ErrNoRows) {
		return membershipFailure{404, "version not found"}, nil
	}
	if err != nil {
		return nil, err
	}
	contentType := previewType(version.Format)
	if contentType == "" {
		return membershipFailure{415, "preview unsupported"}, nil
	}
	return previewResponse{s, ctx, node.Name, version.ObjectKey, contentType, version.Size, r.Params.Range}, nil
}

type previewResponse struct {
	server                 *Server
	ctx                    context.Context
	name, key, contentType string
	size                   int64
	byteRange              *string
}

func (r previewResponse) VisitPreviewFileResponse(w http.ResponseWriter) error {
	obj, err := r.server.transfer.Client.GetObject(r.ctx, r.server.transfer.Bucket, r.key, minio.GetObjectOptions{})
	if err != nil {
		return err
	}
	defer obj.Close()
	info, err := obj.Stat()
	if err != nil {
		return err
	}
	if info.Size != r.size {
		return errors.New("preview object size mismatch")
	}
	w.Header().Set("Content-Type", r.contentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": r.name}))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Native PDF viewers may be disabled by CSP sandbox. PDF is handled by the
	// browser's isolated viewer; executable web formats never reach this response.
	policy := "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'"
	if r.contentType != "application/pdf" {
		policy = "sandbox; " + policy
	}
	w.Header().Set("Content-Security-Policy", policy)
	req, _ := http.NewRequestWithContext(r.ctx, "GET", "/", nil)
	if r.byteRange != nil {
		req.Header.Set("Range", *r.byteRange)
	}
	http.ServeContent(w, req, r.name, time.Time{}, obj)
	return nil
}
