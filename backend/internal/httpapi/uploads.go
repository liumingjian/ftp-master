package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"

	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/permission"
	"github.com/liumingjian/ftp-master/backend/internal/tree"
	"github.com/minio/minio-go/v7"
)

// TransferDependencies separates private operational storage from public capability signing.
type TransferDependencies struct {
	Client, Signer *minio.Client
	Bucket         string
}

const uploadPartSize int64 = 8 * 1024 * 1024

func opaqueKey() string {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func (s *Server) uploadPolicy(ctx context.Context) (api.UploadPolicy, error) {
	var out api.UploadPolicy
	var err error
	out.BlockedExtensions, err = sqlcdb.New(s.membership.Pool).GetUploadPolicy(ctx)
	return out, err
}
func (s *Server) GetUploadPolicy(ctx context.Context, _ api.GetUploadPolicyRequestObject) (api.GetUploadPolicyResponseObject, error) {
	out, err := s.uploadPolicy(ctx)
	return api.GetUploadPolicy200JSONResponse(out), err
}
func (s *Server) SetUploadPolicy(ctx context.Context, r api.SetUploadPolicyRequestObject) (api.SetUploadPolicyResponseObject, error) {
	if !requestFrom(ctx).session.User.IsAdministrator {
		return membershipFailure{403, "Administrator required"}, nil
	}
	if r.Body == nil {
		return membershipFailure{400, "policy required"}, nil
	}
	extensions := make([]string, 0, len(r.Body.BlockedExtensions))
	for _, ext := range r.Body.BlockedExtensions {
		ext = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(ext), "."))
		if ext == "" || strings.ContainsAny(ext, "/\\. \x00") {
			return membershipFailure{400, "invalid extension"}, nil
		}
		extensions = append(extensions, ext)
	}
	tx, err := s.membership.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	err = sqlcdb.New(tx).SetUploadPolicy(ctx, extensions)
	if err != nil {
		return nil, err
	}
	info := requestFrom(ctx)
	err = audit.NewRecorder(sqlcdb.New(tx), s.membership.Clock).Record(ctx, audit.Event{UserID: info.session.User.ID, Username: info.session.User.Username, SourceIP: info.sourceIP, Action: "upload_policy_change", Outcome: audit.OutcomeSuccess, Detail: map[string]any{"blockedExtensions": extensions}})
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return api.SetUploadPolicy200JSONResponse{BlockedExtensions: extensions}, nil
}
func (s *Server) InitiateUpload(ctx context.Context, r api.InitiateUploadRequestObject) (api.InitiateUploadResponseObject, error) {
	if r.Body == nil {
		return membershipFailure{400, "upload required"}, nil
	}
	b := r.Body
	if b.Size < 0 || b.Size > 20000000000 {
		return membershipFailure{400, "file exceeds 20 GB limit"}, nil
	}
	if strings.TrimSpace(b.Name) == "" || len(b.Name) > 255 || strings.ContainsAny(b.Name, "/\\\x00") || strings.HasSuffix(b.Name, ".") || strings.HasSuffix(b.Name, " ") || b.Name == "." || b.Name == ".." {
		return membershipFailure{400, "invalid filename"}, nil
	}
	policy, err := s.uploadPolicy(ctx)
	if err != nil {
		return nil, err
	}
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(b.Name), "."))
	for _, blocked := range policy.BlockedExtensions {
		if ext == blocked {
			return membershipFailure{400, "blocked extension: " + ext}, nil
		}
	}
	snap, err := s.treeSnapshot(ctx, sqlcdb.New(s.membership.Pool))
	if err != nil {
		return nil, err
	}
	if err = treeAccess(snap, b.ParentId, permission.Upload); err != nil {
		return err.(membershipFailure), nil
	}
	parent, _ := snap.Node(b.ParentId)
	if parent.IsFile {
		return membershipFailure{409, "destination must be a directory"}, nil
	}
	id, key := opaqueKey(), opaqueKey()
	core := minio.Core{Client: s.transfer.Client}
	upload, err := core.NewMultipartUpload(ctx, s.transfer.Bucket, key, minio.PutObjectOptions{UserMetadata: map[string]string{"upload-intent": id}})
	if err != nil {
		return nil, err
	}
	count := int((b.Size + uploadPartSize - 1) / uploadPartSize)
	if count == 0 {
		count = 1
	}
	err = sqlcdb.New(s.membership.Pool).CreateUploadSession(ctx, sqlcdb.CreateUploadSessionParams{ID: id, OwnerID: requestFrom(ctx).session.User.ID, ParentID: b.ParentId, Name: b.Name, Size: b.Size, ObjectKey: key, StorageUploadID: upload, PartSize: uploadPartSize, PartCount: int32(count), CreatedAt: pgtype.Timestamptz{Time: s.membership.Clock.Now(), Valid: true}})
	if err != nil {
		_ = core.AbortMultipartUpload(ctx, s.transfer.Bucket, key, upload)
		return nil, err
	}
	return api.InitiateUpload201JSONResponse{Id: id, PartCount: count, PartSize: uploadPartSize}, nil
}

type uploadIntent struct {
	ID, Name, Key, StorageID, State string
	Owner, Parent, Size, PartSize   int64
	Count                           int
	File, Version                   *int64
}

func (s *Server) loadUpload(ctx context.Context, tx pgx.Tx, id string) (uploadIntent, *tree.Snapshot, error) {
	var u uploadIntent
	record, err := sqlcdb.New(tx).GetUploadSessionForUpdate(ctx, id)
	u = uploadIntent{ID: record.ID, Owner: record.OwnerID, Parent: record.ParentID, Name: record.Name, Size: record.Size, Key: record.ObjectKey, StorageID: record.StorageUploadID, PartSize: record.PartSize, Count: int(record.PartCount), State: record.State, File: nullableID(record.FileID.Int64), Version: nullableID(record.VersionID.Int64)}
	if errors.Is(err, pgx.ErrNoRows) || err == nil && u.Owner != requestFrom(ctx).session.User.ID {
		return u, nil, membershipFailure{404, "upload not found"}
	}
	if err != nil {
		return u, nil, err
	}
	snap, err := s.treeSnapshot(ctx, sqlcdb.New(tx))
	if err != nil {
		return u, nil, err
	}
	return u, snap, treeAccess(snap, u.Parent, permission.Upload)
}
func (s *Server) IssueUploadParts(ctx context.Context, r api.IssueUploadPartsRequestObject) (api.IssueUploadPartsResponseObject, error) {
	tx, err := s.membership.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	u, _, err := s.loadUpload(ctx, tx, r.Id)
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	if u.State == "complete" {
		return membershipFailure{409, "upload already completing"}, nil
	}
	if r.Body == nil || len(r.Body.Numbers) == 0 || len(r.Body.Numbers) > 100 {
		return membershipFailure{400, "request 1 to 100 parts"}, nil
	}
	out := api.IssueUploadParts200JSONResponse{}
	for _, n := range r.Body.Numbers {
		if n < 1 || n > u.Count {
			return membershipFailure{400, "invalid part number"}, nil
		}
		signed, e := s.transfer.Signer.Presign(ctx, "PUT", s.transfer.Bucket, u.Key, 15*time.Minute, url.Values{"uploadId": {u.StorageID}, "partNumber": {fmtInt(n)}})
		if e != nil {
			return nil, e
		}
		out = append(out, struct {
			Number int    `json:"number"`
			Url    string `json:"url"`
		}{n, signed.String()})
	}
	return out, nil
}
func fmtInt(n int) string { return strconv.Itoa(n) }
func (s *Server) CompleteUpload(ctx context.Context, r api.CompleteUploadRequestObject) (api.CompleteUploadResponseObject, error) {
	// The session lock serializes retries. Persist completing before touching S3,
	// then recover an ambiguous successful completion from the immutable object.
	tx, err := s.membership.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	u, _, err := s.loadUpload(ctx, tx, r.Id)
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	if u.State == "complete" {
		return api.CompleteUpload200JSONResponse{FileId: *u.File, VersionId: *u.Version}, nil
	}
	err = sqlcdb.New(tx).MarkUploadCompleting(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	tx, err = s.membership.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// Share the tree mutation lock so publication and collision resolution are atomic.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(725010)"); err != nil {
		return nil, err
	}
	u, snap, err := s.loadUpload(ctx, tx, r.Id)
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	if u.State == "complete" {
		return api.CompleteUpload200JSONResponse{FileId: *u.File, VersionId: *u.Version}, nil
	}
	core := minio.Core{Client: s.transfer.Client}
	info, statErr := s.transfer.Client.StatObject(ctx, s.transfer.Bucket, u.Key, minio.StatObjectOptions{})
	if statErr != nil {
		parts := []minio.CompletePart{}
		marker := 0
		var total int64
		for {
			listed, e := core.ListObjectParts(ctx, s.transfer.Bucket, u.Key, u.StorageID, marker, 1000)
			if e != nil {
				return nil, e
			}
			for _, p := range listed.ObjectParts {
				number := len(parts) + 1
				expected := u.PartSize
				if number == u.Count {
					expected = u.Size - int64(number-1)*u.PartSize
				}
				if p.PartNumber != number || number > u.Count || p.Size != expected {
					return membershipFailure{409, "incomplete or incorrectly sized parts"}, nil
				}
				total += p.Size
				parts = append(parts, minio.CompletePart{PartNumber: p.PartNumber, ETag: p.ETag})
			}
			if !listed.IsTruncated {
				break
			}
			marker = listed.NextPartNumberMarker
		}
		if len(parts) != u.Count || total != u.Size {
			return membershipFailure{409, "incomplete parts"}, nil
		}
		_, err = core.CompleteMultipartUpload(ctx, s.transfer.Bucket, u.Key, u.StorageID, parts, minio.PutObjectOptions{})
		if err != nil {
			return nil, err
		}
		info, err = s.transfer.Client.StatObject(ctx, s.transfer.Bucket, u.Key, minio.StatObjectOptions{})
		if err != nil {
			return nil, err
		}
	}
	if info.Size != u.Size || info.UserMetadata["Upload-Intent"] != u.ID && info.UserMetadata["upload-intent"] != u.ID {
		return membershipFailure{409, "object integrity mismatch"}, nil
	}
	for _, n := range snap.Nodes {
		if n.ParentID.Int64 == u.Parent && n.Name == u.Name {
			return membershipFailure{409, "destination name unavailable"}, nil
		}
	}
	q := sqlcdb.New(tx)
	node, err := q.CreateTreeNode(ctx, sqlcdb.CreateTreeNodeParams{ParentID: parentID(&u.Parent), Name: u.Name, IsFile: true})
	if err != nil {
		return nil, err
	}
	created, err := q.CreateFileVersion(ctx, sqlcdb.CreateFileVersionParams{FileID: node.ID, ObjectKey: u.Key, Size: u.Size, Format: strings.ToLower(strings.TrimPrefix(filepath.Ext(u.Name), ".")), CreatedBy: u.Owner, CreatedAt: pgtype.Timestamptz{Time: s.membership.Clock.Now(), Valid: true}})
	version := created.ID
	if err != nil {
		return nil, err
	}
	_, err = q.CreateGrant(ctx, sqlcdb.CreateGrantParams{NodeID: node.ID, PrincipalKind: "user", PrincipalID: u.Owner, Rights: 63, Scope: "subtree", Creator: true})
	if err != nil {
		return nil, err
	}
	infoReq := requestFrom(ctx)
	err = audit.NewRecorder(q, s.membership.Clock).Record(ctx, audit.Event{UserID: u.Owner, Username: infoReq.session.User.Username, SourceIP: infoReq.sourceIP, Action: "upload", Outcome: audit.OutcomeSuccess, ItemID: node.ID, ItemPath: snap.Path(u.Parent) + "/" + u.Name, Detail: map[string]any{"versionId": version, "size": u.Size}})
	if err != nil {
		return nil, err
	}
	err = q.PublishUploadReceipt(ctx, sqlcdb.PublishUploadReceiptParams{ID: u.ID, FileID: pgtype.Int8{Int64: node.ID, Valid: true}, VersionID: pgtype.Int8{Int64: version, Valid: true}})
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return api.CompleteUpload200JSONResponse{FileId: node.ID, VersionId: version}, nil
}
func (e membershipFailure) VisitInitiateUploadResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (e membershipFailure) VisitIssueUploadPartsResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (e membershipFailure) VisitCompleteUploadResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (e membershipFailure) VisitGetUploadPolicyResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (e membershipFailure) VisitSetUploadPolicyResponse(w http.ResponseWriter) error {
	return e.write(w)
}
