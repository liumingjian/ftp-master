// Package httpapi implements the HTTP API defined by the OpenAPI contract.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/netip"
	"unicode/utf8"

	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/health"
	"github.com/liumingjian/ftp-master/backend/internal/identity"
)

// BasePath is where the API is mounted; it matches the contract's server URL.
const BasePath = "/api"

// Options adjusts how the API treats the network around it.
type Options struct {
	// TrustedProxies are the addresses of the reverse proxies in front of
	// the service. For requests from them, the source IP is taken from the
	// X-Forwarded-For entry they appended.
	TrustedProxies []netip.Prefix
	// InsecureSessionCookie drops the Secure attribute from the session
	// cookie, for deployments served over plain HTTP on a non-localhost
	// address. Browsers accept Secure cookies from http://localhost.
	InsecureSessionCookie bool
}

// Server implements api.StrictServerInterface.
type Server struct {
	health   *health.Checker
	identity *identity.Service
	options  Options
}

var _ api.StrictServerInterface = (*Server)(nil)

// NewHandler returns the HTTP handler serving the whole API under BasePath.
// Every operation requires a signed-in, active User unless the contract marks
// it `security: []`.
func NewHandler(checker *health.Checker, identityService *identity.Service, options Options) (http.Handler, error) {
	rules, err := contractRules()
	if err != nil {
		return nil, err
	}
	server := &Server{health: checker, identity: identityService, options: options}
	strict := api.NewStrictHandlerWithOptions(server,
		[]api.StrictMiddlewareFunc{server.guard(rules)},
		api.StrictHTTPServerOptions{
			RequestErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
				writeError(w, http.StatusBadRequest, "bad_request", err.Error())
			},
			ResponseErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
				slog.ErrorContext(r.Context(), "request failed", "method", r.Method, "path", r.URL.Path, "error", err)
				writeError(w, http.StatusInternalServerError, "internal", "internal error")
			},
		})
	return api.HandlerWithOptions(strict, api.StdHTTPServerOptions{BaseURL: BasePath}), nil
}

// GetHealth reports whether the backing stores are reachable. Failure
// details go to the log only: the endpoint is reachable without sign-in.
func (s *Server) GetHealth(ctx context.Context, _ api.GetHealthRequestObject) (api.GetHealthResponseObject, error) {
	report := s.health.Check(ctx)
	body := api.Health{
		Status:        api.Ok,
		Database:      api.DatabaseHealth{Up: report.Database.Up, SchemaVersion: report.Database.SchemaVersion},
		ObjectStorage: api.DependencyHealth{Up: report.ObjectStorage.Up},
		Cache:         api.DependencyHealth{Up: report.Cache.Up},
		CheckedAt:     report.CheckedAt,
		UptimeSeconds: report.UptimeSeconds,
	}
	if report.OK() {
		return api.GetHealth200JSONResponse(body), nil
	}
	slog.WarnContext(ctx, "health check degraded",
		"database", report.Database.Error,
		"objectStorage", report.ObjectStorage.Error,
		"cache", report.Cache.Error,
	)
	body.Status = api.Degraded
	return api.GetHealth503JSONResponse(body), nil
}

// Limits from the contract's SignInRequest; oapi-codegen does not enforce them.
const (
	maxUsernameLength = 150
	maxPasswordLength = 1024
)

// SignIn starts a session for valid credentials.
func (s *Server) SignIn(ctx context.Context, request api.SignInRequestObject) (api.SignInResponseObject, error) {
	body := request.Body
	if utf8.RuneCountInString(body.Username) > maxUsernameLength || utf8.RuneCountInString(body.Password) > maxPasswordLength {
		return badRequest{code: "bad_request", message: "username or password too long"}, nil
	}
	user, token, err := s.identity.SignIn(ctx, body.Username, body.Password, requestFrom(ctx).sourceIP)
	if errors.Is(err, identity.ErrInvalidCredentials) {
		return api.SignIn401JSONResponse{Code: "invalid_credentials", Message: "wrong username or password"}, nil
	}
	if err != nil {
		return nil, err
	}
	cookie := s.sessionCookie(token, 0)
	return api.SignIn200JSONResponse{
		Body:    currentUser(user),
		Headers: api.SignIn200ResponseHeaders{SetCookie: &cookie},
	}, nil
}

// GetSession returns the signed-in User; authenticating has already extended
// the session.
func (s *Server) GetSession(ctx context.Context, _ api.GetSessionRequestObject) (api.GetSessionResponseObject, error) {
	return api.GetSession200JSONResponse(currentUser(requestFrom(ctx).user)), nil
}

// SignOut ends the current session and clears the cookie.
func (s *Server) SignOut(ctx context.Context, _ api.SignOutRequestObject) (api.SignOutResponseObject, error) {
	from := requestFrom(ctx)
	if err := s.identity.SignOut(ctx, from.user, from.sessionToken, from.sourceIP); err != nil {
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
		Name:     sessionCookieName,
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

// badRequest refuses a sign-in with 400, a status the contract leaves implicit.
type badRequest struct{ code, message string }

func (b badRequest) VisitSignInResponse(w http.ResponseWriter) error {
	writeError(w, http.StatusBadRequest, b.code, b.message)
	return nil
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(api.Error{Code: code, Message: message})
}
