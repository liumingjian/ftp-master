package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/permission"
	"github.com/liumingjian/ftp-master/backend/internal/tree"
	"github.com/minio/minio-go/v7"
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

// DownloadFile authorizes access and streams immutable file bytes through the
// application with HTTP Range support and authoritative per-second throughput
// auditing (ADR 0008).
func (s *Server) DownloadFile(ctx context.Context, r api.DownloadFileRequestObject) (api.DownloadFileResponseObject, error) {
	tx, err := s.membership.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
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
	itemPath := snap.Path(r.Id)
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return downloadResponse{
		server:      s,
		ctx:         ctx,
		info:        requestFrom(ctx),
		fileID:      r.Id,
		versionID:   version.ID,
		name:        node.Name,
		path:        itemPath,
		key:         version.ObjectKey,
		size:        version.Size,
		rangeHeader: r.Params.Range,
	}, nil
}

func (e membershipFailure) VisitDownloadFileResponse(w http.ResponseWriter) error { return e.write(w) }

type downloadResponse struct {
	server      *Server
	ctx         context.Context
	info        requestInfo
	fileID      int64
	versionID   int64
	name        string
	path        string
	key         string
	size        int64
	rangeHeader *string
}

func (r downloadResponse) VisitDownloadFileResponse(w http.ResponseWriter) error {
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
		return errors.New("download object size mismatch")
	}

	start := int64(0)
	end := r.size - 1
	isPartial := false
	var byteRange *audit.TransferRange
	if r.rangeHeader != nil && strings.TrimSpace(*r.rangeHeader) != "" {
		rs, re, ok := parseSingleByteRange(*r.rangeHeader, r.size)
		if !ok {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", r.size))
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return nil
		}
		start, end = rs, re
		isPartial = true
		byteRange = &audit.TransferRange{Start: start, End: end}
	}

	var length int64
	if r.size > 0 {
		length = end - start + 1
	}
	if isPartial && start > 0 {
		if _, err := obj.Seek(start, io.SeekStart); err != nil {
			return err
		}
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": r.name}))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
	if isPartial {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, r.size))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.WriteHeader(http.StatusOK)
	}

	sampler := audit.NewTransferSampler(r.server.membership.Clock)
	var copied int64
	var copyErr error
	if length > 0 {
		buf := make([]byte, 32*1024)
		copied, copyErr = io.CopyBuffer(sampler.CountingWriter(w), io.LimitReader(obj, length), buf)
	}
	seg := sampler.Finish()

	failed := copyErr != nil || copied != length
	outcome := audit.OutcomeSuccess
	reason := ""
	if failed {
		outcome = audit.OutcomeFailure
		reason = streamFailureReason(r.ctx, copyErr)
	}
	summary, series := audit.BuildTransferProfile([]audit.TransferSegment{seg}, length, failed, reason, byteRange)
	detail := map[string]any{
		"versionId":       r.versionID,
		"size":            r.size,
		"transferProfile": summary,
	}
	if reason != "" {
		detail["reason"] = reason
	}

	bgCtx := context.WithoutCancel(r.ctx)
	_ = audit.NewRecorder(sqlcdb.New(r.server.membership.Pool), r.server.membership.Clock).Record(bgCtx, audit.Event{
		UserID:         r.info.session.User.ID,
		Username:       r.info.session.User.Username,
		SourceIP:       r.info.sourceIP,
		Action:         "download",
		Outcome:        outcome,
		ItemID:         r.fileID,
		ItemPath:       r.path,
		Detail:         detail,
		TransferSeries: series,
	})
	return nil
}

func parseSingleByteRange(header string, size int64) (int64, int64, bool) {
	if size <= 0 {
		return 0, 0, false
	}
	header = strings.TrimSpace(header)
	if !strings.HasPrefix(header, "bytes=") {
		return 0, 0, false
	}
	spec := strings.TrimSpace(strings.TrimPrefix(header, "bytes="))
	if spec == "" || strings.Contains(spec, ",") {
		return 0, 0, false
	}
	parts := strings.Split(spec, "-")
	if len(parts) != 2 {
		return 0, 0, false
	}
	left, right := strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
	if left == "" {
		// Suffix byte range: bytes=-N
		suffix, err := strconv.ParseInt(right, 10, 64)
		if err != nil || suffix <= 0 {
			return 0, 0, false
		}
		if suffix >= size {
			return 0, size - 1, true
		}
		return size - suffix, size - 1, true
	}
	start, err := strconv.ParseInt(left, 10, 64)
	if err != nil || start < 0 || start >= size {
		return 0, 0, false
	}
	if right == "" {
		return start, size - 1, true
	}
	end, err := strconv.ParseInt(right, 10, 64)
	if err != nil || end < start {
		return 0, 0, false
	}
	if end >= size {
		end = size - 1
	}
	return start, end, true
}

func streamFailureReason(ctx context.Context, err error) string {
	switch {
	case errors.Is(ctx.Err(), context.Canceled):
		return "客户端连接中断"
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return "客户端连接中断（网络超时）"
	case err != nil:
		return "传输流写入中断"
	default:
		return "传输未完整结束"
	}
}
