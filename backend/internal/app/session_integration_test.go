//go:build integration

package app_test

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
)

func TestSignInWithCorrectCredentialsStartsASession(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	browser := newBrowser(t, server)

	status, user := browser.signIn(initialAdministratorUsername, initialAdministratorPassword)

	if status != http.StatusOK {
		t.Fatalf("sign in: status %d, want 200", status)
	}
	if user.Username != initialAdministratorUsername || !user.IsAdministrator {
		t.Errorf("signed in as %+v, want the initial Administrator", user)
	}
	cookie := browser.cookie
	if cookie == nil {
		t.Fatal("no session cookie was set")
	}
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" {
		t.Errorf("session cookie %q must be HttpOnly, Secure, SameSite=Lax, Path=/", cookie.Raw)
	}

	status, current := browser.getSession()
	if status != http.StatusOK || current.Id != user.Id {
		t.Errorf("GET /session: status %d, user %+v; want 200 and the signed-in User", status, current)
	}
}

func TestSignInWithWrongCredentialsIsRefused(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))

	for name, creds := range map[string][2]string{
		"wrong password": {initialAdministratorUsername, "not-the-password"},
		"unknown user":   {"nobody", initialAdministratorPassword},
	} {
		t.Run(name, func(t *testing.T) {
			browser := newBrowser(t, server)
			status, _ := browser.signIn(creds[0], creds[1])
			if status != http.StatusUnauthorized {
				t.Errorf("status %d, want 401", status)
			}
			if browser.cookie != nil {
				t.Errorf("a refused sign-in set cookie %q", browser.cookie.Raw)
			}
			if status, _ := browser.getSession(); status != http.StatusUnauthorized {
				t.Errorf("GET /session after refused sign-in: status %d, want 401", status)
			}
		})
	}
}

// A cross-site HTML form can post JSON-looking text/plain without a CORS
// preflight; accepting it would let another site sign a visitor into an
// account of its choosing.
func TestSignInRefusesBodiesThatAreNotDeclaredJSON(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	body := `{"username":"` + initialAdministratorUsername + `","password":"` + initialAdministratorPassword + `"}`

	for _, contentType := range []string{"text/plain", "application/x-www-form-urlencoded", ""} {
		req, err := http.NewRequest(http.MethodPost, server.URL+"/api/session", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnsupportedMediaType {
			t.Errorf("Content-Type %q: status %d, want 415", contentType, resp.StatusCode)
		}
		for _, c := range resp.Cookies() {
			if c.Name == sessionCookieName && c.Value != "" {
				t.Errorf("Content-Type %q: a session cookie was set", contentType)
			}
		}
	}
}

func TestASessionIdleForTwoHoursIsRejected(t *testing.T) {
	stores := startStores(t)
	clk := clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC))
	server := startService(t, stores.config, clk)
	browser := newBrowser(t, server)
	signInAsAdministrator(t, browser)

	clk.Advance(2*time.Hour - time.Second)
	if status, _ := browser.getSession(); status != http.StatusOK {
		t.Fatalf("after 1h59m59s idle: status %d, want 200", status)
	}

	// That request was activity: the two hours start again from it.
	clk.Advance(2*time.Hour - time.Second)
	if status, _ := browser.getSession(); status != http.StatusOK {
		t.Fatalf("1h59m59s after the last activity: status %d, want 200", status)
	}

	clk.Advance(2 * time.Hour)
	if status, _ := browser.getSession(); status != http.StatusUnauthorized {
		t.Fatalf("after 2h idle: status %d, want 401", status)
	}
}

func TestSigningOutEndsTheSessionImmediately(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	browser := newBrowser(t, server)
	signInAsAdministrator(t, browser)
	stolen := *browser.cookie

	if status := browser.signOut(); status != http.StatusNoContent {
		t.Fatalf("sign out: status %d, want 204", status)
	}
	if browser.cookie != nil {
		t.Error("signing out did not clear the session cookie")
	}

	// A copy of the cookie kept from before is dead too.
	browser.cookie = &stolen
	if status, _ := browser.getSession(); status != http.StatusUnauthorized {
		t.Errorf("old session cookie after sign-out: status %d, want 401", status)
	}
}

func TestEveryProtectedOperationRefusesAnonymousRequests(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	spec, err := api.GetSwagger()
	if err != nil {
		t.Fatal(err)
	}

	public := map[string]bool{}
	for path, item := range spec.Paths.Map() {
		for method, op := range item.Operations() {
			if op.Security != nil && len(*op.Security) == 0 {
				// The embedded contract may capitalise operation ids.
				public[strings.ToLower(op.OperationID[:1])+op.OperationID[1:]] = true
				continue
			}
			// Any value will do for path parameters: the request must be
			// refused before anything is looked up.
			concrete := pathParam.ReplaceAllString(path, "1")
			query := url.Values{}
			for _, parameter := range op.Parameters {
				if p := parameter.Value; p != nil && p.In == "query" && p.Required {
					query.Set(p.Name, "1")
				}
			}
			if len(query) != 0 {
				concrete += "?" + query.Encode()
			}
			for name, cookie := range map[string]*http.Cookie{
				"no cookie":     nil,
				"forged cookie": {Name: sessionCookieName, Value: "forged"},
			} {
				anonymous := newBrowser(t, server)
				anonymous.cookie = cookie
				var payload any
				if op.RequestBody != nil {
					if _, multipart := op.RequestBody.Value.Content["multipart/form-data"]; multipart {
						// Binding initializes the multipart reader before the
						// session guard. The guard must not consume its parts.
						anonymous.header = http.Header{"Content-Type": {"multipart/form-data; boundary=test"}}
					} else {
						payload = map[string]any{}
					}
				}
				status, body := anonymous.do(method, "/api"+concrete, payload)
				if status != http.StatusUnauthorized {
					t.Errorf("%s %s with %s: status %d, want 401", method, path, name, status)
					continue
				}
				if path == "/office/permits/{permitId}/save" {
					// The Office Plugin consumes its own receipt envelope.
					var receipt struct{ Success *bool }
					decode(t, body, &receipt)
					if receipt.Success == nil || *receipt.Success {
						t.Errorf("%s %s with %s: expected failed Office receipt", method, path, name)
					}
					continue
				}
				var e api.Error
				decode(t, body, &e)
				if e.Code != "unauthenticated" {
					t.Errorf("%s %s with %s: code %q, want unauthenticated", method, path, name, e.Code)
				}
			}
		}
	}

	// The Document Gateway is explicitly permit-gated; dedicated tests probe invalid permits.
	want := map[string]bool{"signIn": true, "register": true, "getHealth": true, "getOfficeDocument": true}
	for id := range public {
		if !want[id] {
			t.Errorf("operation %s is reachable without sign-in", id)
		}
	}
}

var pathParam = regexp.MustCompile(`\{[^}]+\}`)

func signInAsAdministrator(t *testing.T, b *browser) api.CurrentUser {
	t.Helper()
	status, user := b.signIn(initialAdministratorUsername, initialAdministratorPassword)
	if status != http.StatusOK {
		t.Fatalf("sign in as the initial Administrator: status %d", status)
	}
	return user
}

// Only an active User may sign in or keep a session. Change the fixture's
// status as the schema owner so the same credentials exercise each case.
func TestOnlyAnActiveUserIsAuthenticated(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	browser := newBrowser(t, server)
	signInAsAdministrator(t, browser)

	setAdministratorStatus(t, stores.config.MigrationDatabaseURL, "deactivated")
	if status, _ := browser.getSession(); status != http.StatusUnauthorized {
		t.Errorf("live session of a deactivated User: status %d, want 401", status)
	}

	for s, expected := range map[string]int{
		"deactivated": http.StatusUnauthorized,
		"pending":     http.StatusForbidden,
		"rejected":    http.StatusUnauthorized,
	} {
		setAdministratorStatus(t, stores.config.MigrationDatabaseURL, s)
		status, _ := newBrowser(t, server).signIn(initialAdministratorUsername, initialAdministratorPassword)
		if status != expected {
			t.Errorf("sign in as a %s User: status %d, want %d", s, status, expected)
		}
	}
}

func setAdministratorStatus(t *testing.T, ownerURL, status string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `UPDATE users SET status = $1 WHERE lower(username) = lower($2)`, status, initialAdministratorUsername); err != nil {
		t.Fatalf("set status %s: %v", status, err)
	}
}
