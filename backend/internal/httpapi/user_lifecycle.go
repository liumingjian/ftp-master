package httpapi

import (
	"context"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"net/http"
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
	_, err := s.changeMembership(ctx, "move_user", func(q *sqlcdb.Queries) (any, error) {
		if r.Body == nil {
			return nil, membershipFailure{400, "Organization required"}
		}
		n, err := q.MoveUser(ctx, sqlcdb.MoveUserParams{ID: r.UserId, OrganizationID: r.Body.OrganizationId})
		if err == nil && n == 0 {
			return nil, membershipFailure{409, "User must be active or deactivated"}
		}
		return map[string]any{"userId": r.UserId, "organizationId": r.Body.OrganizationId}, err
	})
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	return api.MoveUser204Response{}, nil
}
func (s *Server) ListManagedUsers(ctx context.Context, _ api.ListManagedUsersRequestObject) (api.ListManagedUsersResponseObject, error) {
	if !requestFrom(ctx).session.User.IsAdministrator {
		return membershipFailure{403, "Administrator required"}, nil
	}
	rows, err := sqlcdb.New(s.membership.Pool).ListManagedUsers(ctx)
	if err != nil {
		return nil, err
	}
	result := api.ListManagedUsers200JSONResponse{}
	for _, r := range rows {
		result = append(result, api.ManagedUser{Id: r.ID, Username: r.Username, DisplayName: r.DisplayName, Status: r.Status, OrganizationId: r.OrganizationID})
	}
	return result, nil
}
func (e membershipFailure) VisitSetUserStatusResponse(w http.ResponseWriter) error { return e.write(w) }
func (e membershipFailure) VisitMoveUserResponse(w http.ResponseWriter) error      { return e.write(w) }
func (e membershipFailure) VisitListManagedUsersResponse(w http.ResponseWriter) error {
	return e.write(w)
}
