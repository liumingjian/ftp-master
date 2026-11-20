package httpapi

import (
	"context"
	"errors"
	"io"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/minio/minio-go/v7"
)

func (s *Server) GetOfficeDelivery(ctx context.Context, r api.GetOfficeDeliveryRequestObject) (api.GetOfficeDeliveryResponseObject, error) {
	tx, err := s.membership.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// Wait for an in-flight transfer's final commit or rollback before reporting.
	p, err := sqlcdb.New(tx).LockOfficePermit(ctx, r.PermitId)

	if errors.Is(err, pgx.ErrNoRows) {
		return membershipFailure{404, "permit not found"}, nil
	}
	if err != nil {
		return nil, err
	}
	if p.UserID != requestFrom(ctx).session.User.ID {
		return membershipFailure{404, "permit not found"}, nil
	}
	return api.GetOfficeDelivery200JSONResponse{Delivered: p.DeliveredAt.Valid}, nil
}
func (e membershipFailure) VisitGetOfficeDeliveryResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (s *Server) GetOfficeDocument(ctx context.Context, r api.GetOfficeDocumentRequestObject) (api.GetOfficeDocumentResponseObject, error) {
	return officeDocumentResponse{server: s, ctx: ctx, id: r.PermitId}, nil
}

type officeDocumentResponse struct {
	server *Server
	ctx    context.Context
	id     string
}

func (r officeDocumentResponse) VisitGetOfficeDocumentResponse(w http.ResponseWriter) error {
	s, ctx := r.server, r.ctx
	tx, err := s.membership.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	q := sqlcdb.New(tx)
	// Hold the row lock through delivery: competing reads cannot both consume a permit.
	p, err := q.LockOfficePermit(ctx, r.id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "not_found", "permit not found")
		return nil
	}
	if err != nil {
		return err
	}
	if p.DeliveredAt.Valid || !s.membership.Clock.Now().Before(p.ExpiresAt.Time) {
		writeError(w, 410, "expired", "permit unavailable")
		return nil
	}
	obj, err := s.transfer.Client.GetObject(ctx, s.transfer.Bucket, p.ObjectKey, minio.GetObjectOptions{})
	if err != nil {
		return err
	}
	defer obj.Close()
	// Validate the immutable object before sending success headers, including truncation.
	info, err := obj.Stat()
	if err != nil {
		return err
	}
	if info.Size != p.Size {
		return errors.New("Office object size mismatch")
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	// Begin a streamed response before copying even small documents. Proxies
	// must wait for response completion after delivery has been committed.
	if err = http.NewResponseController(w).Flush(); err != nil {
		return nil
	}
	n, err := io.CopyN(w, obj, p.Size)
	// Errors after headers must not append an API error to the document body.
	if err != nil || n != p.Size || ctx.Err() != nil {
		return nil
	}
	if err = http.NewResponseController(w).Flush(); err != nil || ctx.Err() != nil {
		return nil
	}
	// A conservative failure here leaves the permit undelivered and cannot unlock saving.
	if err = q.MarkOfficeDelivered(ctx, sqlcdb.MarkOfficeDeliveredParams{ID: p.ID, DeliveredAt: pgtype.Timestamptz{Time: s.membership.Clock.Now(), Valid: true}}); err != nil {
		return nil
	}
	_ = tx.Commit(ctx)
	return nil
}
