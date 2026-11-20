package httpapi

import (
	"context"
	"net/http"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
)

func (s *Server) Register(ctx context.Context, r api.RegisterRequestObject) (api.RegisterResponseObject, error) {
	b := r.Body
	if b == nil || !validMembershipName(b.Username) || !validMembershipName(b.DisplayName) || !validMembershipName(b.OrganizationHint) || b.Password == "" || utf8.RuneCountInString(b.Password) > 1024 {
		return membershipFailure{400, "all Registration fields are required and must fit their limits"}, nil
	}
	if err := s.identity.Register(ctx, b.Username, b.DisplayName, b.OrganizationHint, b.Password); err != nil {
		f, e := membershipError(err)
		return f, e
	}
	return api.Register201Response{}, nil
}
func (s *Server) ListRegistrations(ctx context.Context, _ api.ListRegistrationsRequestObject) (api.ListRegistrationsResponseObject, error) {
	if !requestFrom(ctx).session.User.IsAdministrator {
		return membershipFailure{403, "Administrator required"}, nil
	}
	rows, err := sqlcdb.New(s.membership.Pool).ListRegistrations(ctx)
	if err != nil {
		return nil, err
	}
	result := api.ListRegistrations200JSONResponse{}
	for _, r := range rows {
		result = append(result, api.Registration{Id: r.ID, Username: r.Username, DisplayName: r.DisplayName, OrganizationHint: r.OrganizationHint})
	}
	return result, nil
}
func (s *Server) ActivateRegistration(ctx context.Context, r api.ActivateRegistrationRequestObject) (api.ActivateRegistrationResponseObject, error) {
	_, err := s.changeMembership(ctx, "activate_registration", func(q *sqlcdb.Queries) (any, error) {
		if r.Body == nil || r.Body.OrganizationId <= 0 {
			return nil, membershipFailure{400, "Organization required"}
		}
		n, err := q.ActivateRegistration(ctx, sqlcdb.ActivateRegistrationParams{ID: r.Id, OrganizationID: r.Body.OrganizationId})
		if err == nil && n == 0 {
			err = pgx.ErrNoRows
		}
		return map[string]any{"id": r.Id, "organizationId": r.Body.OrganizationId}, err
	})
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	return api.ActivateRegistration204Response{}, nil
}
func (s *Server) RejectRegistration(ctx context.Context, r api.RejectRegistrationRequestObject) (api.RejectRegistrationResponseObject, error) {
	_, err := s.changeMembership(ctx, "reject_registration", func(q *sqlcdb.Queries) (any, error) {
		n, err := q.RejectRegistration(ctx, r.Id)
		if err == nil && n == 0 {
			err = pgx.ErrNoRows
		}
		return map[string]any{"id": r.Id}, err
	})
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	return api.RejectRegistration204Response{}, nil
}
func (e membershipFailure) VisitRegisterResponse(w http.ResponseWriter) error { return e.write(w) }
func (e membershipFailure) VisitListRegistrationsResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (e membershipFailure) VisitActivateRegistrationResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (e membershipFailure) VisitRejectRegistrationResponse(w http.ResponseWriter) error {
	return e.write(w)
}
