package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
)

// MembershipDependencies supplies transactional storage and the shared clock.
type MembershipDependencies struct {
	Pool  *pgxpool.Pool
	Clock clock.Clock
}

type membershipFailure struct {
	status  int
	message string
}

func (e membershipFailure) Error() string { return e.message }
func (e membershipFailure) write(w http.ResponseWriter) error {
	writeError(w, e.status, "membership_refused", e.message)
	return nil
}
func membershipError(err error) (membershipFailure, error) {
	var f membershipFailure
	if errors.As(err, &f) {
		return f, nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return membershipFailure{404, "not found"}, nil
	}
	var p *pgconn.PgError
	if errors.As(err, &p) && (p.Code == "23503" || p.Code == "23505") {
		return membershipFailure{409, "organization or membership is still in use, or referenced principal does not exist"}, nil
	}
	return membershipFailure{}, err
}
func validMembershipName(name string) bool {
	return strings.TrimSpace(name) != "" && utf8.RuneCountInString(name) <= 150
}
func orgResponse(row sqlcdb.Organization) api.Organization {
	var parent *int64
	if row.ParentID.Valid {
		v := row.ParentID.Int64
		parent = &v
	}
	return api.Organization{Id: row.ID, Name: row.Name, ParentId: parent}
}
func parentID(p *int64) pgtype.Int8 {
	if p == nil {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: *p, Valid: true}
}

// Changes and their Audit Event commit together. A transaction-level lock
// serializes hierarchy rewrites so concurrent moves cannot create a cycle.
func (s *Server) changeMembership(ctx context.Context, operation string, change func(*sqlcdb.Queries) (any, error)) (any, error) {
	info := requestFrom(ctx)
	if !info.session.User.IsAdministrator {
		return nil, membershipFailure{403, "Administrator required"}
	}
	tx, err := s.membership.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(725005)"); err != nil {
		return nil, err
	}
	q := sqlcdb.New(tx)
	result, err := change(q)
	if err != nil {
		return nil, err
	}
	recorder := audit.NewRecorder(q, s.membership.Clock)
	err = recorder.Record(ctx, audit.Event{UserID: info.session.User.ID, Username: info.session.User.Username, SourceIP: info.sourceIP, Action: audit.Action("account_change"), Outcome: audit.OutcomeSuccess, Detail: map[string]any{"operation": operation, "result": result}})
	if err != nil {
		return nil, err
	}
	return result, tx.Commit(ctx)
}
func (s *Server) ListOrganizations(ctx context.Context, _ api.ListOrganizationsRequestObject) (api.ListOrganizationsResponseObject, error) {
	if !requestFrom(ctx).session.User.IsAdministrator {
		return api.ListOrganizations403JSONResponse{Code: "forbidden", Message: "Administrator required"}, nil
	}
	rows, err := sqlcdb.New(s.membership.Pool).ListOrganizations(ctx)
	if err != nil {
		return nil, err
	}
	result := api.ListOrganizations200JSONResponse{}
	for _, row := range rows {
		result = append(result, orgResponse(row))
	}
	return result, nil
}
func (s *Server) CreateOrganization(ctx context.Context, r api.CreateOrganizationRequestObject) (api.CreateOrganizationResponseObject, error) {
	result, err := s.changeMembership(ctx, "create_organization", func(q *sqlcdb.Queries) (any, error) {
		if r.Body == nil || !validMembershipName(r.Body.Name) {
			return nil, membershipFailure{400, "name must contain 1 to 150 characters"}
		}
		row, err := q.CreateOrganization(ctx, sqlcdb.CreateOrganizationParams{Name: r.Body.Name, ParentID: parentID(r.Body.ParentId)})
		return orgResponse(row), err
	})
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	return api.CreateOrganization201JSONResponse(result.(api.Organization)), nil
}
func (s *Server) UpdateOrganization(ctx context.Context, r api.UpdateOrganizationRequestObject) (api.UpdateOrganizationResponseObject, error) {
	result, err := s.changeMembership(ctx, "update_organization", func(q *sqlcdb.Queries) (any, error) {
		if r.Body == nil || !validMembershipName(r.Body.Name) {
			return nil, membershipFailure{400, "name must contain 1 to 150 characters"}
		}
		rows, err := q.ListOrganizations(ctx)
		if err != nil {
			return nil, err
		}
		parents := map[int64]int64{}
		for _, row := range rows {
			parents[row.ID] = row.ParentID.Int64
		}
		if r.Body.ParentId != nil {
			for id := *r.Body.ParentId; id != 0; id = parents[id] {
				if id == r.Id {
					return nil, membershipFailure{409, "Organization move would create a cycle"}
				}
			}
		}
		row, err := q.UpdateOrganization(ctx, sqlcdb.UpdateOrganizationParams{ID: r.Id, Name: r.Body.Name, ParentID: parentID(r.Body.ParentId)})
		return orgResponse(row), err
	})
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	return api.UpdateOrganization200JSONResponse(result.(api.Organization)), nil
}
func (s *Server) DeleteOrganization(ctx context.Context, r api.DeleteOrganizationRequestObject) (api.DeleteOrganizationResponseObject, error) {
	_, err := s.changeMembership(ctx, "delete_organization", func(q *sqlcdb.Queries) (any, error) {
		n, err := q.DeleteOrganization(ctx, r.Id)
		if err == nil && n == 0 {
			err = pgx.ErrNoRows
		}
		return map[string]any{"id": r.Id}, err
	})
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	return api.DeleteOrganization204Response{}, nil
}
func (s *Server) ListUserGroups(ctx context.Context, _ api.ListUserGroupsRequestObject) (api.ListUserGroupsResponseObject, error) {
	if !requestFrom(ctx).session.User.IsAdministrator {
		return api.ListUserGroups403JSONResponse{Code: "forbidden", Message: "Administrator required"}, nil
	}
	rows, err := sqlcdb.New(s.membership.Pool).ListUserGroups(ctx)
	if err != nil {
		return nil, err
	}
	result := api.ListUserGroups200JSONResponse{}
	for _, row := range rows {
		result = append(result, api.UserGroup{Id: row.ID, Name: row.Name, UserIds: row.UserIds})
	}
	return result, nil
}
func (s *Server) CreateUserGroup(ctx context.Context, r api.CreateUserGroupRequestObject) (api.CreateUserGroupResponseObject, error) {
	result, err := s.changeMembership(ctx, "create_user_group", func(q *sqlcdb.Queries) (any, error) {
		if r.Body == nil || !validMembershipName(r.Body.Name) {
			return nil, membershipFailure{400, "name must contain 1 to 150 characters"}
		}
		row, err := q.CreateUserGroup(ctx, r.Body.Name)
		return api.UserGroup{Id: row.ID, Name: row.Name, UserIds: []int64{}}, err
	})
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	return api.CreateUserGroup201JSONResponse(result.(api.UserGroup)), nil
}
func (s *Server) SetUserGroupMembers(ctx context.Context, r api.SetUserGroupMembersRequestObject) (api.SetUserGroupMembersResponseObject, error) {
	_, err := s.changeMembership(ctx, "set_user_group_members", func(q *sqlcdb.Queries) (any, error) {
		if r.Body == nil || r.Body.UserIds == nil {
			return nil, membershipFailure{400, "userIds array required"}
		}
		if _, err := q.GetUserGroup(ctx, r.Id); err != nil {
			return nil, err
		}
		if err := q.ClearUserGroupMembers(ctx, r.Id); err != nil {
			return nil, err
		}
		for _, id := range r.Body.UserIds {
			if err := q.AddUserGroupMember(ctx, sqlcdb.AddUserGroupMemberParams{GroupID: r.Id, UserID: id}); err != nil {
				return nil, err
			}
		}
		return map[string]any{"groupId": r.Id, "userIds": r.Body.UserIds}, nil
	})
	if err != nil {
		f, e := membershipError(err)
		return f, e
	}
	return api.SetUserGroupMembers204Response{}, nil
}
func (e membershipFailure) VisitCreateOrganizationResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (e membershipFailure) VisitUpdateOrganizationResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (e membershipFailure) VisitDeleteOrganizationResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (e membershipFailure) VisitCreateUserGroupResponse(w http.ResponseWriter) error {
	return e.write(w)
}
func (e membershipFailure) VisitSetUserGroupMembersResponse(w http.ResponseWriter) error {
	return e.write(w)
}
