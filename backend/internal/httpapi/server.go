// Package httpapi implements the HTTP API defined by the OpenAPI contract.
package httpapi

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/health"
)

// BasePath is where the API is mounted; it matches the contract's server URL.
const BasePath = "/api"

// Server implements api.StrictServerInterface.
type Server struct {
	health *health.Checker
}

var _ api.StrictServerInterface = (*Server)(nil)

// NewHandler returns the HTTP handler serving the whole API under BasePath.
func NewHandler(checker *health.Checker) http.Handler {
	server := &Server{health: checker}
	return api.HandlerWithOptions(
		api.NewStrictHandler(server, nil),
		api.StdHTTPServerOptions{BaseURL: BasePath},
	)
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
