package httpapi

import (
	"context"
	"errors"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/identity"
	"net/http"
	"unicode/utf8"
)

type passwordResponse struct {
	status int
	code   string
}

func (p passwordResponse) write(w http.ResponseWriter) error {
	if p.status == 204 {
		w.WriteHeader(204)
	} else {
		writeError(w, p.status, p.code, p.code)
	}
	return nil
}
func (p passwordResponse) VisitChangePasswordResponse(w http.ResponseWriter) error { return p.write(w) }
func (p passwordResponse) VisitResetPasswordResponse(w http.ResponseWriter) error  { return p.write(w) }
func (s *Server) password(ctx context.Context, target int64, current, next string, reset bool) (passwordResponse, error) {
	if utf8.RuneCountInString(next) < 1 || utf8.RuneCountInString(next) > 1024 || utf8.RuneCountInString(current) > 1024 {
		return passwordResponse{400, "bad_request"}, nil
	}
	info := requestFrom(ctx)
	err := s.identity.ChangePassword(ctx, info.session.User, target, current, next, reset, info.sourceIP)
	if errors.Is(err, identity.ErrForbidden) {
		return passwordResponse{403, "forbidden"}, nil
	}
	if errors.Is(err, identity.ErrUserNotFound) {
		return passwordResponse{404, "not_found"}, nil
	}
	return passwordResponse{204, ""}, err
}
func (s *Server) ChangePassword(ctx context.Context, r api.ChangePasswordRequestObject) (api.ChangePasswordResponseObject, error) {
	return s.password(ctx, requestFrom(ctx).session.User.ID, r.Body.CurrentPassword, r.Body.NewPassword, false)
}
func (s *Server) ResetPassword(ctx context.Context, r api.ResetPasswordRequestObject) (api.ResetPasswordResponseObject, error) {
	return s.password(ctx, r.UserId, "", r.Body.NewPassword, true)
}
