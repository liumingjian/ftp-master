package httpapi

import (
	"context"
	"errors"
	"net/http"
	"unicode/utf8"

	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/identity"
)

// SignIn starts a session for valid credentials.
func (s *Server) SignIn(ctx context.Context, request api.SignInRequestObject) (api.SignInResponseObject, error) {
	body := request.Body
	limits := s.contract.signInLimits
	if utf8.RuneCountInString(body.Username) > limits.username || utf8.RuneCountInString(body.Password) > limits.password {
		return signInBadRequest{code: "bad_request", message: "username or password too long"}, nil
	}
	session, err := s.identity.SignIn(ctx, body.Username, body.Password, requestFrom(ctx).sourceIP)
	if errors.Is(err, identity.ErrInvalidCredentials) {
		return api.SignIn401JSONResponse{Code: "invalid_credentials", Message: "wrong username or password"}, nil
	}
	if err != nil {
		return nil, err
	}
	cookie := s.sessionCookie(session.Token, 0)
	return api.SignIn200JSONResponse{
		Body:    currentUser(session.User),
		Headers: api.SignIn200ResponseHeaders{SetCookie: &cookie},
	}, nil
}

// GetSession returns the signed-in User; authenticating has already extended
// the session.
func (s *Server) GetSession(ctx context.Context, _ api.GetSessionRequestObject) (api.GetSessionResponseObject, error) {
	return api.GetSession200JSONResponse(currentUser(requestFrom(ctx).session.User)), nil
}

// SignOut ends the current session and clears the cookie.
func (s *Server) SignOut(ctx context.Context, _ api.SignOutRequestObject) (api.SignOutResponseObject, error) {
	from := requestFrom(ctx)
	if err := s.identity.SignOut(ctx, from.session, from.sourceIP); err != nil {
		return nil, err
	}
	cookie := s.sessionCookie("", -1)
	return api.SignOut204Response{Headers: api.SignOut204ResponseHeaders{SetCookie: &cookie}}, nil
}

// sessionCookie renders the Set-Cookie value for token. It is a browser
// session cookie (maxAge 0): the server alone decides idle expiry. A negative
// maxAge deletes it.
func (s *Server) sessionCookie(token string, maxAge int) string {
	cookie := &http.Cookie{
		Name:     s.contract.sessionCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   !s.options.InsecureSessionCookie,
		SameSite: http.SameSiteLaxMode,
	}
	return cookie.String()
}

func currentUser(u identity.User) api.CurrentUser {
	return api.CurrentUser{
		Id:              u.ID,
		Username:        u.Username,
		DisplayName:     u.DisplayName,
		IsAdministrator: u.IsAdministrator,
	}
}

// signInBadRequest refuses a sign-in with 400, a status the contract leaves
// implicit.
type signInBadRequest struct{ code, message string }

func (b signInBadRequest) VisitSignInResponse(w http.ResponseWriter) error {
	writeError(w, http.StatusBadRequest, b.code, b.message)
	return nil
}
