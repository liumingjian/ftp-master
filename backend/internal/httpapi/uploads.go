package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"

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
	if u.File != nil {
		if _, ok := snap.Node(*u.File); !ok {
			return u, nil, membershipFailure{404, "upload not found"}
		}
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
	if r.Params.Collision != nil {
		choice := string(*r.Params.Collision)
		if choice != "new_version" && choice != "keep_both" {
			return membershipFailure{400, "invalid collision choice"}, nil
		}
		if _, err = tx.Exec(ctx, "UPDATE upload_sessions SET collision=$2 WHERE id=$1", u.ID, choice); err != nil {
			return nil, err
		}
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
	var collision string
	if err = tx.QueryRow(ctx, "SELECT collision FROM upload_sessions WHERE id=$1", u.ID).Scan(&collision); err != nil {
		return nil, err
	}
	var batchID, relativePath string
	if err = tx.QueryRow(ctx, "SELECT coalesce(batch_id,''),relative_path FROM upload_sessions WHERE id=$1", u.ID).Scan(&batchID, &relativePath); err != nil {
		return nil, err
	}
	var existing *sqlcdb.TreeNode
	for i := range snap.Nodes {
		n := &snap.Nodes[i]
		if batchID == "" && n.ParentID.Int64 == u.Parent && n.Name == u.Name {
			existing = n
			break
		}
	}
	overwrite := false
	if existing != nil {
		visible := snap.Permission(existing.ID).Rights.Has(permission.Browse) && snap.NavigationVisible(existing.ID)
		if visible && collision == "" {
			return membershipFailure{409, "upload_name_conflict"}, nil
		}
		overwrite = visible && collision == "new_version" && existing.IsFile
		if visible && collision == "new_version" && !existing.IsFile {
			return membershipFailure{409, "destination is a directory; keep both instead"}, nil
		}
		if !overwrite {
			original := u.Name
			for counter := 1; ; counter++ {
				suffix := fmt.Sprintf(" (%d)", counter)
				if !visible {
					suffix = " (" + opaqueKey()[:12] + ")"
				}
				ext := filepath.Ext(original)
				base := strings.TrimSuffix(original, ext)
				limit := 255 - len(suffix) - len(ext)
				if limit < 1 {
					ext = ""
					limit = 255 - len(suffix)
				}
				for len(base) > limit {
					_, size := utf8.DecodeLastRuneInString(base)
					base = base[:len(base)-size]
				}
				candidate := base + suffix + ext
				used := false
				for _, n := range snap.Nodes {
					if n.ParentID.Int64 == u.Parent && n.Name == candidate {
						used = true
						break
					}
				}
				if !used {
					u.Name = candidate
					break
				}
			}
		}
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
	uploadPath := snap.Path(u.Parent) + "/" + u.Name
	if batchID != "" {
		var rootName string
		if err = tx.QueryRow(ctx, "SELECT n.name FROM upload_batches b JOIN tree_nodes n ON n.id=b.root_id WHERE b.id=$1", batchID).Scan(&rootName); err != nil {
			return nil, err
		}
		uploadPath = snap.Path(u.Parent) + "/" + rootName + "/" + relativePath
		var parent int64
		if err = tx.QueryRow(ctx, "SELECT root_id FROM upload_batches WHERE id=$1", batchID).Scan(&parent); err != nil {
			return nil, err
		}
		segments := strings.Split(relativePath, "/")
		for _, segment := range segments[:len(segments)-1] {
			var next int64
			err = tx.QueryRow(ctx, "SELECT id FROM tree_nodes WHERE parent_id=$1 AND name=$2 AND NOT is_file AND deleted_at IS NULL", parent, segment).Scan(&next)
			if errors.Is(err, pgx.ErrNoRows) {
				n, e := sqlcdb.New(tx).CreateTreeNode(ctx, sqlcdb.CreateTreeNodeParams{ParentID: parentID(&parent), Name: segment, IsFile: false})
				if e != nil {
					return nil, e
				}
				next = n.ID
				if _, e = tx.Exec(ctx, "INSERT INTO upload_batch_nodes VALUES($1,$2)", next, batchID); e != nil {
					return nil, e
				}
			} else if err != nil {
				return nil, err
			}
			parent = next
		}
		u.Parent = parent
	}
	q := sqlcdb.New(tx)
	var node sqlcdb.TreeNode
	if overwrite {
		node = *existing
	} else {
		node, err = q.CreateTreeNode(ctx, sqlcdb.CreateTreeNodeParams{ParentID: parentID(&u.Parent), Name: u.Name, IsFile: true})
		if err != nil {
			return nil, err
		}
	}
	if batchID != "" {
		if _, err = tx.Exec(ctx, "INSERT INTO upload_batch_nodes VALUES($1,$2)", node.ID, batchID); err != nil {
			return nil, err
		}
	}
	created, err := q.CreateFileVersion(ctx, sqlcdb.CreateFileVersionParams{FileID: node.ID, ObjectKey: u.Key, Size: u.Size, Format: strings.ToLower(strings.TrimPrefix(filepath.Ext(u.Name), ".")), CreatedBy: u.Owner, CreatedAt: pgtype.Timestamptz{Time: s.membership.Clock.Now(), Valid: true}})
	version := created.ID
	if err != nil {
		return nil, err
	}
	if !overwrite {
		_, err = q.CreateGrant(ctx, sqlcdb.CreateGrantParams{NodeID: node.ID, PrincipalKind: "user", PrincipalID: u.Owner, Rights: 63, Scope: "subtree", Creator: true})
		if err != nil {
			return nil, err
		}
	}
	infoReq := requestFrom(ctx)
	err = audit.NewRecorder(q, s.membership.Clock).Record(ctx, audit.Event{UserID: u.Owner, Username: infoReq.session.User.Username, SourceIP: infoReq.sourceIP, Action: "upload", Outcome: audit.OutcomeSuccess, ItemID: node.ID, ItemPath: uploadPath, Detail: map[string]any{"versionId": version, "size": u.Size, "newVersion": overwrite}})
	if err != nil {
		return nil, err
	}
	err = q.PublishUploadReceipt(ctx, sqlcdb.PublishUploadReceiptParams{ID: u.ID, FileID: pgtype.Int8{Int64: node.ID, Valid: true}, VersionID: pgtype.Int8{Int64: version, Valid: true}})
	if err != nil {
		return nil, err
	}
	if batchID != "" {
		var ready bool
		if err = tx.QueryRow(ctx, "SELECT count(*)=b.expected AND bool_and(s.state='complete') FROM upload_batches b JOIN upload_sessions s ON s.batch_id=b.id WHERE b.id=$1 GROUP BY b.expected", batchID).Scan(&ready); err != nil {
			return nil, err
		}
		if ready {
			if _, err = tx.Exec(ctx, "INSERT INTO grants(node_id,principal_kind,principal_id,rights,scope,creator) SELECT root_id,'user',owner_id,63,'subtree',true FROM upload_batches WHERE id=$1", batchID); err != nil {
				return nil, err
			}
			if _, err = tx.Exec(ctx, "DELETE FROM upload_batch_nodes WHERE batch_id=$1", batchID); err != nil {
				return nil, err
			}
		}
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

// ListUploadParts consults storage on every resume: browser progress is advisory.
func (s *Server) ListUploadParts(ctx context.Context, r api.ListUploadPartsRequestObject) (api.ListUploadPartsResponseObject, error) {
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
	out := api.ListUploadParts200JSONResponse{}
	if u.State == "complete" {
		for n := 1; n <= u.Count; n++ {
			out = append(out, struct {
				Number int `json:"number"`
			}{n})
		}
		return out, nil
	}
	core := minio.Core{Client: s.transfer.Client}
	marker := 0
	for {
		listed, e := core.ListObjectParts(ctx, s.transfer.Bucket, u.Key, u.StorageID, marker, 1000)
		if e != nil {
			return nil, e
		}
		for _, p := range listed.ObjectParts {
			expected := u.PartSize
			if p.PartNumber == u.Count {
				expected = u.Size - int64(u.Count-1)*u.PartSize
			}
			if p.PartNumber >= 1 && p.PartNumber <= u.Count && p.Size == expected {
				out = append(out, struct {
					Number int `json:"number"`
				}{p.PartNumber})
			}
		}
		if !listed.IsTruncated {
			break
		}
		marker = listed.NextPartNumberMarker
	}
	return out, nil
}
func (e membershipFailure) VisitListUploadPartsResponse(w http.ResponseWriter) error {
	return e.write(w)
}
