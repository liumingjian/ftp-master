package httpapi

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/db"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/permission"
	"github.com/minio/minio-go/v7"
)

const zipLimit int64 = 10_000_000_000

type zipEntry struct {
	id         int64
	path, name string
	version    sqlcdb.FileVersion
}

func (s *Server) DownloadZip(ctx context.Context, r api.DownloadZipRequestObject) (api.DownloadZipResponseObject, error) {
	ids := map[int64]bool{}
	if len(r.Params.Ids) > 20000 {
		return membershipFailure{400, "invalid selection"}, nil
	}
	for _, raw := range strings.Split(r.Params.Ids, ",") {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id < 1 {
			return membershipFailure{400, "invalid selection"}, nil
		}
		ids[id] = true
	}
	tx, err := s.membership.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err = db.LockSharedTreeTx(ctx, tx); err != nil {
		return nil, err
	}
	q := sqlcdb.New(tx)
	snap, err := s.treeSnapshot(ctx, q)
	if err != nil {
		return nil, err
	}
	// Invisible selections never expand into descendants.
	for id := range ids {
		if !snap.Visible(id) {
			delete(ids, id)
		}
	}
	entries := []zipEntry{}
	var total int64
	used := map[string]bool{}
	for _, node := range snap.Nodes {
		if !node.IsFile || !snap.Permission(node.ID).Rights.Has(permission.Download) {
			continue
		}
		selected := false
		for id := node.ID; id != 0; {
			if ids[id] {
				selected = true
			}
			n, ok := snap.Node(id)
			if !ok {
				break
			}
			id = n.ParentID.Int64
		}
		if !selected {
			continue
		}
		version, err := q.GetFileVersion(ctx, sqlcdb.GetFileVersionParams{FileID: node.ID})
		if err != nil {
			return nil, err
		}
		if version.Size < 0 || version.Size > zipLimit-total {
			return membershipFailure{413, "zip exceeds 10 GB"}, nil
		}
		total += version.Size
		// Preserve the full tree path, sanitizing every component independently.
		parts := []string{}
		for id := node.ID; id != 0; {
			n, _ := snap.Node(id)
			name := strings.Map(func(r rune) rune {
				if r == '/' || r == '\\' || r < 32 || r == 127 || r == ':' {
					return '_'
				}
				return r
			}, n.Name)
			if name == "" || name == "." || name == ".." {
				name = "_"
			}
			parts = append([]string{name}, parts...)
			id = n.ParentID.Int64
		}
		name := strings.Join(parts, "/")
		if used[name] {
			name = fmt.Sprintf("%s (%d)", name, node.ID)
		}
		used[name] = true
		entries = append(entries, zipEntry{node.ID, snap.Path(node.ID), name, version})
	}
	if r.Params.Preflight != nil && *r.Params.Preflight {
		return api.DownloadZip204Response{Headers: api.DownloadZip204ResponseHeaders{
			XFileCount: len(entries), XTotalBytes: total,
		}}, nil
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return zipResponse{s, ctx, entries, total}, nil
}
func (e membershipFailure) VisitDownloadZipResponse(w http.ResponseWriter) error { return e.write(w) }

type zipResponse struct {
	server        *Server
	ctx           context.Context
	entries       []zipEntry
	expectedTotal int64
}

func (r zipResponse) VisitDownloadZipResponse(w http.ResponseWriter) error {
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="download.zip"`)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	sampler := audit.NewTransferSampler(r.server.membership.Clock)
	out := zip.NewWriter(sampler.CountingWriter(w))
	allFiles := make([]map[string]any, 0, len(r.entries))
	for _, entry := range r.entries {
		allFiles = append(allFiles, map[string]any{"id": entry.id, "path": entry.path})
	}
	recordAudit := func(failed bool, reason string) error {
		seg := sampler.Finish()
		totalBytes := r.expectedTotal
		if seg.BytesTransferred > totalBytes {
			totalBytes = seg.BytesTransferred
		}
		summary, series := audit.BuildTransferProfile([]audit.TransferSegment{seg}, totalBytes, failed, reason, nil)
		detail := map[string]any{
			"files":           allFiles,
			"transferProfile": summary,
		}
		outcome := audit.OutcomeSuccess
		if failed {
			outcome = audit.OutcomeFailure
			detail["reason"] = reason
		}
		info := requestFrom(r.ctx)
		return audit.NewRecorder(sqlcdb.New(r.server.membership.Pool), r.server.membership.Clock).Record(
			context.WithoutCancel(r.ctx),
			audit.Event{
				UserID:         info.session.User.ID,
				Username:       info.session.User.Username,
				SourceIP:       info.sourceIP,
				Action:         "zip_download",
				Outcome:        outcome,
				Detail:         detail,
				TransferSeries: series,
			},
		)
	}

	buf := make([]byte, 32*1024)
	for _, entry := range r.entries {
		obj, err := r.server.transfer.Client.GetObject(r.ctx, r.server.transfer.Bucket, entry.version.ObjectKey, minio.GetObjectOptions{})
		if err != nil {
			_ = recordAudit(true, streamFailureReason(r.ctx, err))
			panic(http.ErrAbortHandler)
		}
		info, err := obj.Stat()
		if err != nil || info.Size != entry.version.Size {
			obj.Close()
			_ = recordAudit(true, "源对象读取异常")
			panic(http.ErrAbortHandler)
		}
		writer, err := out.CreateHeader(&zip.FileHeader{Name: entry.name, Method: zip.Store})
		if err != nil {
			obj.Close()
			_ = recordAudit(true, streamFailureReason(r.ctx, err))
			panic(http.ErrAbortHandler)
		}
		copied, err := io.CopyBuffer(writer, obj, buf)
		obj.Close()
		if err != nil || copied != entry.version.Size {
			_ = recordAudit(true, streamFailureReason(r.ctx, err))
			panic(http.ErrAbortHandler)
		}
	}
	if err := out.Close(); err != nil {
		_ = recordAudit(true, streamFailureReason(r.ctx, err))
		panic(http.ErrAbortHandler)
	}
	// Record exactly one completed packing operation with its Transfer Profile.
	if err := recordAudit(false, ""); err != nil {
		panic(http.ErrAbortHandler)
	}
	return nil
}
