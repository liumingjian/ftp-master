package httpapi

import (
	"context"
	"errors"
	"mime"
	"net/http"
	"net/netip"

	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/identity"
)

// requestInfo is what the authentication middleware learned about a request.
type requestInfo struct {
	sourceIP netip.Addr
	// session is set for operations that require one.
	session identity.Session
}

type requestInfoKey struct{}

func requestFrom(ctx context.Context) requestInfo {
	info, _ := ctx.Value(requestInfoKey{}).(requestInfo)
	return info
}

// guard enforces what the contract says about every operation before its
// handler runs:
//   - an operation whose body may only be JSON refuses any other declared
//     Content-Type with 415. Browsers send cross-site forms as text/plain or
//     urlencoded without a CORS preflight, so this is what stops another site
//     from posting to the API in a visitor's name (for sign-in: login CSRF).
//   - every operation not marked public refuses requests without the session
//     cookie of an active User with 401.
//
// It also records the request's source IP and User for the handlers.
func (s *Server) guard() api.StrictMiddlewareFunc {
	return func(next api.StrictHandlerFunc, operationID string) api.StrictHandlerFunc {
		return func(ctx context.Context, w http.ResponseWriter, r *http.Request, request any) (any, error) {
			if s.contract.jsonBody[operationID] && !isJSON(r.Header.Get("Content-Type")) {
				writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "the body must be application/json")
				return nil, nil
			}
			info := requestInfo{sourceIP: sourceIP(r, s.options.TrustedProxies)}
			if !s.contract.public[operationID] {
				session, err := s.authenticated(ctx, r)
				if errors.Is(err, identity.ErrUnauthenticated) {
					writeError(w, http.StatusUnauthorized, "unauthenticated", "sign in first")
					return nil, nil
				}
				if err != nil {
					return nil, err
				}
				info.session = session
			}
			return next(context.WithValue(ctx, requestInfoKey{}, info), w, r, request)
		}
	}
}

// authenticated returns the live session of an active User that r's session
// cookie names.
func (s *Server) authenticated(ctx context.Context, r *http.Request) (identity.Session, error) {
	cookie, err := r.Cookie(s.contract.sessionCookieName)
	if err != nil {
		return identity.Session{}, identity.ErrUnauthenticated
	}
	return s.identity.Authenticate(ctx, cookie.Value)
}

func isJSON(contentType string) bool {
	mediaType, _, err := mime.ParseMediaType(contentType)
	return err == nil && mediaType == "application/json"
}
