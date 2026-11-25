package httpapi

import (
	"context"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/quota"
)

type apiFailure struct {
	status  int
	code    string
	message string
}

func (e apiFailure) Error() string { return e.message }

func (e apiFailure) write(w http.ResponseWriter) error {
	writeError(w, e.status, e.code, e.message)
	return nil
}

func (e apiFailure) VisitCreateOrganizationResponse(w http.ResponseWriter) error { return e.write(w) }
func (e apiFailure) VisitUpdateOrganizationResponse(w http.ResponseWriter) error { return e.write(w) }
func (e apiFailure) VisitMoveUserResponse(w http.ResponseWriter) error           { return e.write(w) }
func (e apiFailure) VisitSetUserQuotaResponse(w http.ResponseWriter) error       { return e.write(w) }

func int8Ptr(v pgtype.Int8) *int64 {
	if !v.Valid {
		return nil
	}
	n := v.Int64
	return &n
}

func optionalInt8(p *int64) pgtype.Int8 {
	if p == nil {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: *p, Valid: true}
}

func sameOptionalInt64(a, b *int64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// loadQuotaLedger loads a consistent snapshot of Organizations, Users,
// deduplicated committed File Version bytes, and active upload reservations
// from the caller's query/transaction handle and evaluates the quota Ledger.
func loadQuotaLedger(ctx context.Context, q *sqlcdb.Queries) (*quota.Ledger, []sqlcdb.Organization, error) {
	orgRows, err := q.ListOrganizations(ctx)
	if err != nil {
		return nil, nil, err
	}
	userRows, err := q.ListUsersForQuota(ctx)
	if err != nil {
		return nil, nil, err
	}
	committedRows, err := q.ListCommittedBytesByUser(ctx)
	if err != nil {
		return nil, nil, err
	}
	reservedRows, err := q.ListReservedBytesByUser(ctx)
	if err != nil {
		return nil, nil, err
	}

	committedByUser := make(map[int64]int64, len(committedRows))
	for _, r := range committedRows {
		committedByUser[r.UserID] = r.CommittedBytes
	}
	reservedByUser := make(map[int64]int64, len(reservedRows))
	for _, r := range reservedRows {
		reservedByUser[r.UserID] = r.ReservedBytes
	}

	snap := quota.Snapshot{
		Organizations: make([]quota.Organization, 0, len(orgRows)),
		Users:         make([]quota.User, 0, len(userRows)),
	}
	for _, o := range orgRows {
		snap.Organizations = append(snap.Organizations, quota.Organization{
			ID:         o.ID,
			Name:       o.Name,
			ParentID:   int8Ptr(o.ParentID),
			QuotaBytes: int8Ptr(o.QuotaBytes),
		})
	}
	for _, u := range userRows {
		snap.Users = append(snap.Users, quota.User{
			ID:             u.ID,
			OrganizationID: u.OrganizationID,
			QuotaBytes:     int8Ptr(u.QuotaBytes),
			CommittedBytes: committedByUser[u.ID],
			ReservedBytes:  reservedByUser[u.ID],
		})
	}
	return quota.Evaluate(snap), orgRows, nil
}

func orgSummaryResponse(s quota.OrganizationSummary) api.Organization {
	return api.Organization{
		Id:               s.ID,
		Name:             s.Name,
		ParentId:         s.ParentID,
		QuotaBytes:       s.QuotaBytes,
		CommittedBytes:   s.CommittedBytes,
		ReservedBytes:    s.ReservedBytes,
		UsedBytes:        s.UsedBytes,
		AllocatedBytes:   s.AllocatedBytes,
		UnallocatedBytes: s.UnallocatedBytes,
	}
}

func managedUserResponse(r sqlcdb.User, u quota.User) api.ManagedUser {
	return api.ManagedUser{
		Id:             r.ID,
		Username:       r.Username,
		DisplayName:    r.DisplayName,
		Status:         r.Status,
		OrganizationId: r.OrganizationID,
		QuotaBytes:     u.QuotaBytes,
		CommittedBytes: u.CommittedBytes,
		ReservedBytes:  u.ReservedBytes,
		UsedBytes:      u.UsedBytes(),
	}
}

func quotaViolationError(v *quota.Violation) error {
	if v == nil {
		return nil
	}
	switch v.Kind {
	case quota.ViolationInvalidQuota:
		return apiFailure{400, "invalid_quota", "存储配额不能为负数"}
	case quota.ViolationOrganizationNotFound:
		return pgx.ErrNoRows
	case quota.ViolationParentNotFound:
		return membershipFailure{409, "organization or membership is still in use, or referenced principal does not exist"}
	case quota.ViolationCycle:
		return membershipFailure{409, "Organization move would create a cycle"}
	case quota.ViolationQuotaBelowAllocated:
		return apiFailure{
			status:  409,
			code:    "quota_conflict",
			message: fmt.Sprintf("组织配额（%s）不能低于下级已分配配额总计（%s）", quota.FormatBytes(v.QuotaBytes), quota.FormatBytes(v.AllocatedBytes)),
		}
	case quota.ViolationAncestorBudgetExceeded:
		return apiFailure{
			status:  409,
			code:    "quota_conflict",
			message: fmt.Sprintf("超出组织“%s”剩余可分配配额（可用 %s，需要 %s）", v.OrganizationName, quota.FormatBytes(v.AvailableBytes), quota.FormatBytes(v.RequiredBytes)),
		}
	default:
		return apiFailure{409, "quota_conflict", "存储配额冲突"}
	}
}

func recordQuotaChangeAudit(ctx context.Context, q *sqlcdb.Queries, clk clock.Clock, info requestInfo, targetKind string, targetID int64, targetName string, previous, next *int64) error {
	var prevVal any
	if previous != nil {
		prevVal = *previous
	}
	var nextVal any
	if next != nil {
		nextVal = *next
	}
	return audit.NewRecorder(q, clk).Record(ctx, audit.Event{
		UserID:   info.session.User.ID,
		Username: info.session.User.Username,
		SourceIP: info.sourceIP,
		Action:   audit.Action("quota_change"),
		Outcome:  audit.OutcomeSuccess,
		Detail: map[string]any{
			"targetKind":         targetKind,
			"targetId":           targetID,
			"targetName":         targetName,
			"previousQuotaBytes": prevVal,
			"newQuotaBytes":      nextVal,
		},
	})
}
