// Package httpapi implements the HTTP API defined by the OpenAPI contract.
package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/netip"
	"strings"

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
	transfer   TransferDependencies
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
func NewHandler(checker *health.Checker, identityService *identity.Service, options Options, membership MembershipDependencies, transfers ...TransferDependencies) (http.Handler, error) {
	contract, err := readContract()
	if err != nil {
		return nil, err
	}
	server := &Server{membership: membership, health: checker, identity: identityService, options: options, contract: contract}
	if len(transfers) > 0 {
		server.transfer = transfers[0]
	}
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
	handler := api.HandlerWithOptions(strict, api.StdHTTPServerOptions{BaseURL: BasePath})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && strings.HasPrefix(r.URL.Path, BasePath+"/office/permits/") && strings.HasSuffix(r.URL.Path, "/save") {
			r.Body = http.MaxBytesReader(w, r.Body, 26*1024*1024)
			recorder := &officeResponseBuffer{header: make(http.Header), Code: 200}
			handler.ServeHTTP(recorder, r)
			if recorder.Code >= 400 {
				var receipt map[string]any
				if json.Unmarshal(recorder.Body.Bytes(), &receipt) != nil || receipt["Success"] != false {
					message := "save failed"
					if m, ok := receipt["message"].(string); ok {
						message = m
					}
					writeOfficeReceipt(w, recorder.Code, message)
					return
				}
			}
			for k, v := range recorder.Header() {
				w.Header()[k] = v
			}
			w.WriteHeader(recorder.Code)
			_, _ = w.Write(recorder.Body.Bytes())
			return
		}
		handler.ServeHTTP(w, r)
	}), nil
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
