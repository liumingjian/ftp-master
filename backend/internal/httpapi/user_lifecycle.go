package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
)

func (s *Server) SetUserStatus(ctx context.Context, r api.SetUserStatusRequestObject) (api.SetUserStatusResponseObject, error) {
	_, err := s.changeMembership(ctx, "set_user_status", func(q *sqlcdb.Queries) (any, error) {
		if r.Body == nil || (r.Body.Status != "active" && r.Body.Status != "deactivated") {
			return nil, membershipFailure{400, "active or deactivated status required"}
		}
		n, err := q.SetUserStatus(ctx, sqlcdb.SetUserStatusParams{ID: r.UserId, Status: string(r.Body.Status)})
		if err == nil && n == 0 {
			return nil, membershipFailure{409, "User must be active or deactivated"}
		}
		return map[string]any{"userId": r.UserId, "status": r.Body.Status}, err
	})
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	return api.SetUserStatus204Response{}, nil
}

func (s *Server) MoveUser(ctx context.Context, r api.MoveUserRequestObject) (api.MoveUserResponseObject, error) {
	info := requestFrom(ctx)
	_, err := s.changeMembership(ctx, "move_user", func(q *sqlcdb.Queries) (any, error) {
		if r.Body == nil {
			return nil, membershipFailure{400, "Organization required"}
		}
		target, err := q.GetUser(ctx, r.UserId)
		if err != nil {
			return nil, err
		}
		if target.Status != "active" && target.Status != "deactivated" {
			return nil, membershipFailure{409, "User must be active or deactivated"}
		}
		ledger, _, err := loadQuotaLedger(ctx, q)
		if err != nil {
			return nil, err
		}
		if _, ok := ledger.Organization(r.Body.OrganizationId); !ok {
			return nil, membershipFailure{409, "organization or membership is still in use, or referenced principal does not exist"}
		}

		existingQuota := int8Ptr(target.QuotaBytes)
		updateQuota := (r.Body.UpdateQuota != nil && *r.Body.UpdateQuota) || (r.Body.UpdateQuota == nil && r.Body.QuotaBytes != nil)
		targetQuota := existingQuota
		if updateQuota {
			targetQuota = r.Body.QuotaBytes
		}
		if v := ledger.ValidateUserChange(target.ID, r.Body.OrganizationId, targetQuota); v != nil {
			return nil, quotaViolationError(v)
		}

		var n int64
		if updateQuota {
			n, err = q.MoveUserWithQuota(ctx, sqlcdb.MoveUserWithQuotaParams{
				ID:             r.UserId,
				OrganizationID: r.Body.OrganizationId,
				QuotaBytes:     optionalInt8(targetQuota),
			})
		} else {
			n, err = q.MoveUser(ctx, sqlcdb.MoveUserParams{
				ID:             r.UserId,
				OrganizationID: r.Body.OrganizationId,
			})
		}
		if err != nil {
			return nil, err
		}
		if n == 0 {
			return nil, membershipFailure{409, "User must be active or deactivated"}
		}
		if !sameOptionalInt64(existingQuota, targetQuota) {
			if err := recordQuotaChangeAudit(ctx, q, s.membership.Clock, info, "user", target.ID, target.Username, existingQuota, targetQuota); err != nil {
				return nil, err
			}
		}
		return map[string]any{"userId": r.UserId, "organizationId": r.Body.OrganizationId}, nil
	})
	if err != nil {
		var af apiFailure
		if errors.As(err, &af) {
			return af, nil
		}
		f, e := membershipError(err)
		return f, e
	}
	return api.MoveUser204Response{}, nil
}

func (s *Server) SetUserQuota(ctx context.Context, r api.SetUserQuotaRequestObject) (api.SetUserQuotaResponseObject, error) {
	info := requestFrom(ctx)
	if !info.session.User.IsAdministrator {
		return membershipFailure{403, "Administrator required"}, nil
	}
	if r.Body == nil {
		return membershipFailure{400, "quota payload required"}, nil
	}
	tx, err := s.membership.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(725005)"); err != nil {
		return nil, err
	}
	q := sqlcdb.New(tx)
	target, err := q.GetUser(ctx, r.UserId)
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	if target.Status != "active" && target.Status != "deactivated" {
		return membershipFailure{409, "User must be active or deactivated"}, nil
	}
	ledger, _, err := loadQuotaLedger(ctx, q)
	if err != nil {
		return nil, err
	}
	if v := ledger.ValidateUserChange(target.ID, target.OrganizationID, r.Body.QuotaBytes); v != nil {
		verr := quotaViolationError(v)
		var af apiFailure
		if errors.As(verr, &af) {
			return af, nil
		}
		f, e := membershipError(verr)
		return f, e
	}
	n, err := q.SetUserQuota(ctx, sqlcdb.SetUserQuotaParams{
		ID:         target.ID,
		QuotaBytes: optionalInt8(r.Body.QuotaBytes),
	})
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	if n == 0 {
		return membershipFailure{409, "User must be active or deactivated"}, nil
	}
	prevQuota := int8Ptr(target.QuotaBytes)
	if !sameOptionalInt64(prevQuota, r.Body.QuotaBytes) {
		if err := recordQuotaChangeAudit(ctx, q, s.membership.Clock, info, "user", target.ID, target.Username, prevQuota, r.Body.QuotaBytes); err != nil {
			return nil, err
		}
	}
	nextLedger, _, err := loadQuotaLedger(ctx, q)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	u, _ := nextLedger.User(target.ID)
	return api.SetUserQuota200JSONResponse(managedUserResponse(target, u)), nil
}

func (s *Server) ListManagedUsers(ctx context.Context, _ api.ListManagedUsersRequestObject) (api.ListManagedUsersResponseObject, error) {
	if !requestFrom(ctx).session.User.IsAdministrator {
		return membershipFailure{403, "Administrator required"}, nil
	}
	tx, err := s.membership.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	q := sqlcdb.New(tx)
	rows, err := q.ListManagedUsers(ctx)
	if err != nil {
		return nil, err
	}
	ledger, _, err := loadQuotaLedger(ctx, q)
	if err != nil {
		return nil, err
	}
	result := make(api.ListManagedUsers200JSONResponse, 0, len(rows))
	for _, r := range rows {
		u, _ := ledger.User(r.ID)
		result = append(result, managedUserResponse(r, u))
	}
	return result, nil
}

func (e membershipFailure) VisitSetUserStatusResponse(w http.ResponseWriter) error { return e.write(w) }
func (e membershipFailure) VisitMoveUserResponse(w http.ResponseWriter) error      { return e.write(w) }
func (e membershipFailure) VisitSetUserQuotaResponse(w http.ResponseWriter) error  { return e.write(w) }
func (e membershipFailure) VisitListManagedUsersResponse(w http.ResponseWriter) error {
	return e.write(w)
}
