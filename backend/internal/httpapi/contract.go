package httpapi

import (
	"fmt"
	"strings"

	"github.com/getkin/kin-openapi/openapi3"

	"github.com/liumingjian/ftp-master/backend/internal/api"
)

// contractFacts are what the handlers enforce on the contract's behalf, read
// from the embedded contract so they cannot drift from it.
type contractFacts struct {
	// public operations are exempt from sign-in with `security: []`.
	// Everything else requires a session, including operations that state no
	// security at all, so a forgotten declaration fails closed. Keyed by the
	// operation names the strict middleware sees.
	public map[string]bool
	// jsonBody operations accept a request body only as application/json.
	jsonBody map[string]bool
	// sessionCookieName is the cookie of the session security scheme.
	sessionCookieName string
	// signInLimits are SignInRequest's maxLength limits, which oapi-codegen
	// does not enforce.
	signInLimits signInLimits
}

// signInLimits are the longest username and password, in characters, that
// sign-in accepts.
type signInLimits struct {
	username, password int
}

func readContract() (contractFacts, error) {
	spec, err := api.GetSwagger()
	if err != nil {
		return contractFacts{}, fmt.Errorf("load embedded contract: %w", err)
	}
	facts := contractFacts{public: map[string]bool{}, jsonBody: map[string]bool{}}
	for _, item := range spec.Paths.Map() {
		for _, op := range item.Operations() {
			name := strings.ToUpper(op.OperationID[:1]) + op.OperationID[1:]
			if op.Security != nil && len(*op.Security) == 0 {
				facts.public[name] = true
			}
			if body := op.RequestBody; body != nil && body.Value != nil {
				content := body.Value.Content
				if len(content) == 1 && content.Get("application/json") != nil {
					facts.jsonBody[name] = true
				}
			}
		}
	}

	scheme := spec.Components.SecuritySchemes["session"]
	if scheme == nil || scheme.Value == nil || scheme.Value.In != "cookie" || scheme.Value.Name == "" {
		return contractFacts{}, fmt.Errorf("contract: security scheme session must be a named cookie")
	}
	facts.sessionCookieName = scheme.Value.Name

	signIn := spec.Components.Schemas["SignInRequest"]
	if signIn == nil || signIn.Value == nil {
		return contractFacts{}, fmt.Errorf("contract: schema SignInRequest is missing")
	}
	if facts.signInLimits.username, err = maxLength(signIn.Value, "username"); err != nil {
		return contractFacts{}, err
	}
	if facts.signInLimits.password, err = maxLength(signIn.Value, "password"); err != nil {
		return contractFacts{}, err
	}
	return facts, nil
}

func maxLength(schema *openapi3.Schema, property string) (int, error) {
	prop := schema.Properties[property]
	if prop == nil || prop.Value == nil || prop.Value.MaxLength == nil {
		return 0, fmt.Errorf("contract: SignInRequest.%s needs a maxLength", property)
	}
	return int(*prop.Value.MaxLength), nil
}
