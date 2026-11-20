//go:build integration

package app_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/liumingjian/ftp-master/backend/internal/api"
)

const sessionCookieName = "ftp_master_session"

// browser is one client of the API holding at most one session cookie. It
// keeps the cookie itself, rather than through a cookiejar, because the cookie
// is Secure and the test server speaks plain HTTP.
type browser struct {
	t      *testing.T
	server *httptest.Server
	cookie *http.Cookie
	// header is added to every request.
	header http.Header
}

func newBrowser(t *testing.T, server *httptest.Server) *browser {
	return &browser{t: t, server: server}
}

// do sends a request and returns the status and body, remembering any
// session cookie the response sets or clears.
func (b *browser) do(method, path string, body any) (int, []byte) {
	b.t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			b.t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(method, b.server.URL+path, reader)
	if err != nil {
		b.t.Fatal(err)
	}
	for name, values := range b.header {
		req.Header[name] = values
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if b.cookie != nil {
		req.AddCookie(&http.Cookie{Name: b.cookie.Name, Value: b.cookie.Value})
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		b.t.Fatal(err)
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		b.t.Fatal(err)
	}
	for _, c := range resp.Cookies() {
		if c.Name != sessionCookieName {
			continue
		}
		if c.MaxAge < 0 || c.Value == "" {
			b.cookie = nil
		} else {
			b.cookie = c
		}
	}
	return resp.StatusCode, respBody
}

func (b *browser) signIn(username, password string) (int, api.CurrentUser) {
	b.t.Helper()
	status, body := b.do(http.MethodPost, "/api/session", api.SignInRequest{Username: username, Password: password})
	var user api.CurrentUser
	if status == http.StatusOK {
		decode(b.t, body, &user)
	}
	return status, user
}

func (b *browser) getSession() (int, api.CurrentUser) {
	b.t.Helper()
	status, body := b.do(http.MethodGet, "/api/session", nil)
	var user api.CurrentUser
	if status == http.StatusOK {
		decode(b.t, body, &user)
	}
	return status, user
}

func (b *browser) signOut() int {
	b.t.Helper()
	status, _ := b.do(http.MethodDelete, "/api/session", nil)
	return status
}

func decode(t *testing.T, body []byte, v any) {
	t.Helper()
	if err := json.Unmarshal(body, v); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
}
