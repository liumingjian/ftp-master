package httpapi

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/quota"
)

// GetMyStorage returns the signed-in User's own live Storage Usage, personal
// User Quota, effective headroom/ceiling, constraining ancestor Organization
// aggregate status (without exposing any peer Users or the Organization tree),
// and the caller's own incomplete single-file uploads and unrevealed folder
// upload batches.
func (s *Server) GetMyStorage(ctx context.Context, _ api.GetMyStorageRequestObject) (api.GetMyStorageResponseObject, error) {
	userID := requestFrom(ctx).session.User.ID

	tx, err := s.membership.Pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	q := sqlcdb.New(tx)
	ledger, _, err := loadQuotaLedger(ctx, q)
	if err != nil {
		return nil, err
	}
	pendingUploadRows, err := q.ListUserPendingUploads(ctx, userID)
	if err != nil {
		return nil, err
	}
	pendingBatchRows, err := q.ListUserPendingUploadBatches(ctx, userID)
	if err != nil {
		return nil, err
	}

	summary, ok := ledger.UserStorage(userID)
	if !ok {
		return api.GetMyStorage401JSONResponse{
			UnauthorizedJSONResponse: api.UnauthorizedJSONResponse{
				Code:    "unauthenticated",
				Message: "authentication required",
			},
		}, nil
	}

	var effectiveScope *api.SelfStorageSummaryEffectiveScope
	if summary.EffectiveScope != quota.ScopeNone {
		scope := api.SelfStorageSummaryEffectiveScope(summary.EffectiveScope)
		effectiveScope = &scope
	}

	var constrainingOrg *api.ConstrainingOrganizationStorage
	if summary.ConstrainingOrganization != nil {
		org := summary.ConstrainingOrganization
		constrainingOrg = &api.ConstrainingOrganizationStorage{
			Name:                     org.Name,
			QuotaBytes:               org.QuotaBytes,
			UsedBytes:                org.UsedBytes,
			AllocatedBytes:           org.AllocatedBytes,
			UnallocatedPoolBytes:     org.UnallocatedPoolBytes,
			UnallocatedPoolUsedBytes: org.UnallocatedPoolUsedBytes,
			RemainingBytes:           org.RemainingBytes,
			ConstraintKind:           api.ConstrainingOrganizationStorageConstraintKind(org.ConstraintKind),
		}
	}

	pendingUploads := make([]api.PendingUpload, 0, len(pendingUploadRows))
	for _, row := range pendingUploadRows {
		pendingUploads = append(pendingUploads, api.PendingUpload{
			Id:        row.ID,
			Name:      row.Name,
			Size:      row.Size,
			ParentId:  row.ParentID,
			CreatedAt: row.CreatedAt.Time.UTC(),
			State:     api.PendingUploadState(row.State),
		})
	}

	pendingBatches := make([]api.PendingUploadBatch, 0, len(pendingBatchRows))
	for _, row := range pendingBatchRows {
		pendingBatches = append(pendingBatches, api.PendingUploadBatch{
			Id:             row.ID,
			Name:           row.Name,
			FileCount:      int(row.FileCount),
			ReservedBytes:  row.ReservedBytes,
			CommittedBytes: row.CommittedBytes,
			TotalBytes:     row.TotalBytes,
			ParentId:       row.ParentID,
			CreatedAt:      row.CreatedAt.Time.UTC(),
		})
	}

	return api.GetMyStorage200JSONResponse{
		CommittedBytes:           summary.CommittedBytes,
		ReservedBytes:            summary.ReservedBytes,
		UsedBytes:                summary.UsedBytes,
		QuotaBytes:               summary.QuotaBytes,
		AvailableBytes:           summary.AvailableBytes,
		EffectiveLimitBytes:      summary.EffectiveLimitBytes,
		EffectiveUsedBytes:       summary.EffectiveUsedBytes,
		EffectiveScope:           effectiveScope,
		ConstrainingOrganization: constrainingOrg,
		PendingUploads:           pendingUploads,
		PendingBatches:           pendingBatches,
	}, nil
}
