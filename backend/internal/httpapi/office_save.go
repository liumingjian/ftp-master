package httpapi

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/permission"
)

type officeFailure struct {
	status  int
	message string
}

func (f officeFailure) VisitSaveOfficeResponse(w http.ResponseWriter) error {
	writeOfficeReceipt(w, f.status, f.message)
	return nil
}
func writeOfficeReceipt(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"Success": false, "Message": message, "Data": nil})
}

func officePayload(reader *multipart.Reader) ([]byte, string, error) {
	fields := map[string][]byte{}
	filenames := map[string]string{}
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, "", err
		}
		name := part.FormName()
		if name != "file" && name != "filedata" && name != "md5sum" && name != "filename" {
			return nil, "", errors.New("unexpected field")
		}
		if _, ok := fields[name]; ok {
			return nil, "", errors.New("duplicate field")
		}
		value, err := io.ReadAll(io.LimitReader(part, 25*1024*1024+1))
		if err != nil || len(value) > 25*1024*1024 {
			return nil, "", errors.New("invalid or oversized field")
		}
		fields[name] = value
		filenames[name] = part.FileName()
	}
	if data, ok := fields["file"]; ok && len(fields) == 1 && filenames["file"] == "" {
		return data, "spreadsheet", nil
	}
	data, ok := fields["filedata"]
	if !ok || len(fields) != 3 || len(fields["filename"]) == 0 || len(fields["md5sum"]) != 32 {
		return nil, "", errors.New("invalid save shape")
	}
	sum := md5.Sum(data)
	expected, err := hex.DecodeString(string(fields["md5sum"]))
	if err != nil || !bytes.Equal(sum[:], expected) {
		return nil, "", errors.New("checksum mismatch")
	}
	return data, "word", nil
}
func officeFamily(format string) string {
	switch format {
	case "doc", "docx", "wps":
		return "word"
	case "xls", "xlsx":
		return "spreadsheet"
	}
	return ""
}
func (s *Server) SaveOffice(ctx context.Context, r api.SaveOfficeRequestObject) (api.SaveOfficeResponseObject, error) {
	data, shape, err := officePayload(r.Body)
	if err != nil {
		return officeFailure{400, err.Error()}, nil
	}
	format, err := validateOffice(data)
	if err != nil || officeFamily(format) != shape {
		return officeFailure{415, "invalid Office content"}, nil
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
	p, err := q.LockOfficePermit(ctx, r.PermitId)
	info := requestFrom(ctx)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && p.UserID != info.session.User.ID {
		return officeFailure{404, "permit not found"}, nil
	}
	if err != nil {
		return nil, err
	}
	if !p.DeliveredAt.Valid {
		return officeFailure{409, "document not delivered"}, nil
	}
	snap, err := s.treeSnapshot(ctx, q)
	if err != nil {
		return nil, err
	}
	if err = treeAccess(snap, p.FileID, permission.Modify); err != nil {
		var f membershipFailure
		if errors.As(err, &f) {
			return officeFailure{f.status, f.message}, nil
		}
		return nil, err
	}
	if officeFamily(p.Format) != officeFamily(format) {
		return officeFailure{415, "different document family"}, nil
	}
	latest, err := q.GetFileVersion(ctx, sqlcdb.GetFileVersionParams{FileID: p.FileID})
	if err != nil {
		return nil, err
	}
	key := opaqueKey()
	committed := false
	defer s.rollbackImmutableObject(ctx, key, &committed)()
	if err = s.writeImmutableObject(ctx, key, data, "application/octet-stream"); err != nil {
		return nil, err
	}

	v, err := q.CreateFileVersion(ctx, sqlcdb.CreateFileVersionParams{FileID: p.FileID, ObjectKey: key, Size: int64(len(data)), Format: format, CreatedBy: info.session.User.ID, CreatedAt: pgtype.Timestamptz{Time: s.membership.Clock.Now(), Valid: true}})
	if err != nil {
		return nil, err
	}
	detail := map[string]any{"versionId": v.ID, "baseVersionId": p.VersionID, "permitId": p.ID, "staleSave": latest.ID != p.VersionID, "format": format}
	if err = audit.NewRecorder(q, s.membership.Clock).Record(ctx, audit.Event{UserID: info.session.User.ID, Username: info.session.User.Username, SourceIP: info.sourceIP, Action: "office_save", Outcome: audit.OutcomeSuccess, ItemID: p.FileID, ItemPath: snap.Path(p.FileID), Detail: detail}); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	committed = true
	return api.SaveOffice200JSONResponse{Success: true, Message: "Saved", Data: &detail}, nil
}

// Buffer only the small save receipt so router, decoder and authentication failures
// share the editor's receipt contract before any response headers are sent.
type officeResponseBuffer struct {
	header http.Header
	Code   int
	Body   bytes.Buffer
}

func (b *officeResponseBuffer) Header() http.Header            { return b.header }
func (b *officeResponseBuffer) WriteHeader(status int)         { b.Code = status }
func (b *officeResponseBuffer) Write(data []byte) (int, error) { return b.Body.Write(data) }
