package httpapi

import (
	"context"
	"net/http"

	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
)

func (s *Server) GetOfficeEditPolicy(ctx context.Context, _ api.GetOfficeEditPolicyRequestObject) (api.GetOfficeEditPolicyResponseObject, error) {
	enabled, err := sqlcdb.New(s.membership.Pool).GetOfficeEditEnabled(ctx)
	return api.GetOfficeEditPolicy200JSONResponse{Enabled: &enabled}, err
}

func (s *Server) SetOfficeEditPolicy(ctx context.Context, r api.SetOfficeEditPolicyRequestObject) (api.SetOfficeEditPolicyResponseObject, error) {
	info := requestFrom(ctx)
	if !info.session.User.IsAdministrator {
		return membershipFailure{403, "Administrator required"}, nil
	}
	if r.Body == nil || r.Body.Enabled == nil {
		return membershipFailure{400, "policy required"}, nil
	}
	tx, err := s.membership.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	q := sqlcdb.New(tx)
	if err := q.SetOfficeEditEnabled(ctx, *r.Body.Enabled); err != nil {
		return nil, err
	}
	err = audit.NewRecorder(q, s.membership.Clock).Record(ctx, audit.Event{
		UserID: info.session.User.ID, Username: info.session.User.Username, SourceIP: info.sourceIP,
		Action: "office_edit_policy_change", Outcome: audit.OutcomeSuccess, Detail: map[string]any{"enabled": *r.Body.Enabled},
	})
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return api.SetOfficeEditPolicy200JSONResponse{Enabled: r.Body.Enabled}, nil
}

func (e membershipFailure) VisitSetOfficeEditPolicyResponse(w http.ResponseWriter) error {
	return e.write(w)
}
