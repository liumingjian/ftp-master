// Package httpapi implements the HTTP API defined by the OpenAPI contract.
package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/netip"

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
	membership MembershipDependencies
	health     *health.Checker
	identity   *identity.Service
	options    Options
	contract   contractFacts
}

var _ api.StrictServerInterface = (*Server)(nil)

// NewHandler returns the HTTP handler serving the whole API under BasePath.
// Every operation requires a signed-in, active User unless the contract marks
// it `security: []`.
func NewHandler(checker *health.Checker, identityService *identity.Service, options Options, membership MembershipDependencies) (http.Handler, error) {
	contract, err := readContract()
	if err != nil {
		return nil, err
	}
	server := &Server{membership: membership, health: checker, identity: identityService, options: options, contract: contract}
	strict := api.NewStrictHandlerWithOptions(server,
		[]api.StrictMiddlewareFunc{server.guard()},
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

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(api.Error{Code: code, Message: message})
}
