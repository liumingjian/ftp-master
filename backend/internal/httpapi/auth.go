package httpapi

import (
	"context"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/netip"
	"strings"

	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/identity"
)

// sessionCookieName matches the contract's session security scheme.
const sessionCookieName = "ftp_master_session"

// requestInfo is what the authentication middleware learned about a request.
type requestInfo struct {
	sourceIP netip.Addr
	// user and sessionToken are set for operations that require a session.
	user         identity.User
	sessionToken string
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
func (s *Server) guard(rules operationRules) api.StrictMiddlewareFunc {
	return func(next api.StrictHandlerFunc, operationID string) api.StrictHandlerFunc {
		return func(ctx context.Context, w http.ResponseWriter, r *http.Request, request any) (any, error) {
			if rules.jsonBody[operationID] && !isJSON(r.Header.Get("Content-Type")) {
				writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "the body must be application/json")
				return nil, nil
			}
			info := requestInfo{sourceIP: sourceIP(r, s.options.TrustedProxies)}
			if !rules.public[operationID] {
				user, token, err := s.authenticated(ctx, r)
				if errors.Is(err, identity.ErrUnauthenticated) {
					writeError(w, http.StatusUnauthorized, "unauthenticated", "sign in first")
					return nil, nil
				}
				if err != nil {
					return nil, err
				}
				info.user, info.sessionToken = user, token
			}
			return next(context.WithValue(ctx, requestInfoKey{}, info), w, r, request)
		}
	}
}

// authenticated returns the active User whose session cookie r carries.
func (s *Server) authenticated(ctx context.Context, r *http.Request) (identity.User, string, error) {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		return identity.User{}, "", identity.ErrUnauthenticated
	}
	user, err := s.identity.Authenticate(ctx, cookie.Value)
	return user, cookie.Value, err
}

func isJSON(contentType string) bool {
	mediaType, _, err := mime.ParseMediaType(contentType)
	return err == nil && mediaType == "application/json"
}

// operationRules are the per-operation facts guard enforces, read from the
// contract and keyed by the operation names the strict middleware sees.
type operationRules struct {
	// public operations are exempt from sign-in with `security: []`.
	// Everything else requires a session, including operations that state no
	// security at all, so a forgotten declaration fails closed.
	public map[string]bool
	// jsonBody operations accept a request body only as application/json.
	jsonBody map[string]bool
}

func contractRules() (operationRules, error) {
	spec, err := api.GetSwagger()
	if err != nil {
		return operationRules{}, fmt.Errorf("load embedded contract: %w", err)
	}
	rules := operationRules{public: map[string]bool{}, jsonBody: map[string]bool{}}
	for _, item := range spec.Paths.Map() {
		for _, op := range item.Operations() {
			name := strings.ToUpper(op.OperationID[:1]) + op.OperationID[1:]
			if op.Security != nil && len(*op.Security) == 0 {
				rules.public[name] = true
			}
			if body := op.RequestBody; body != nil && body.Value != nil {
				content := body.Value.Content
				if len(content) == 1 && content.Get("application/json") != nil {
					rules.jsonBody[name] = true
				}
			}
		}
	}
	return rules, nil
}
