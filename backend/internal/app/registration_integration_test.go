//go:build integration

package app_test

import (
	"fmt"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"testing"
	"time"
)

func TestRegistrationApprovalAndRejection(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	applicant := newBrowser(t, server)
	body := map[string]any{"username": "new.employee", "displayName": "New Employee", "organizationHint": "Engineering", "password": "secret"}
	if status, data := applicant.do("POST", "/api/registrations", body); status != 201 {
		t.Fatalf("registration: %d %s", status, data)
	}
	if status, _ := applicant.signIn("new.employee", "wrong"); status != 401 {
		t.Fatal(status)
	}
	if status, data := applicant.signIn("new.employee", "secret"); status != 403 {
		t.Fatalf("pending: %d %+v", status, data)
	}
	admin := newBrowser(t, server)
	administrator := signInAsAdministrator(t, admin)
	var pending []struct {
		ID int64 `json:"id"`
	}
	status, data := admin.do("GET", "/api/registrations", nil)
	if status != 200 {
		t.Fatal(status)
	}
	decode(t, data, &pending)
	if len(pending) != 1 {
		t.Fatalf("pending %s", data)
	}
	path := fmt.Sprintf("/api/registrations/%d/activate", pending[0].ID)
	if status, data := admin.do("POST", path, map[string]any{"organizationId": 999999}); status != 409 {
		t.Fatalf("missing org %d %s", status, data)
	}
	if status, data := admin.do("POST", path, map[string]any{"organizationId": 1}); status != 204 {
		t.Fatalf("activate %d %s", status, data)
	}
	if status, _ := applicant.signIn("new.employee", "secret"); status != 200 {
		t.Fatal(status)
	}
	body["username"] = "rejected"
	if status, _ := applicant.do("POST", "/api/registrations", body); status != 201 {
		t.Fatal(status)
	}
	_, data = admin.do("GET", "/api/registrations", nil)
	decode(t, data, &pending)
	if status, data := admin.do("POST", fmt.Sprintf("/api/registrations/%d/reject", pending[0].ID), nil); status != 204 {
		t.Fatalf("reject %d %s", status, data)
	}
	if status, _ := applicant.signIn("rejected", "secret"); status != 401 {
		t.Fatal(status)
	}
	if status, _ := applicant.do("POST", "/api/registrations", body); status != 409 {
		t.Fatal(status)
	}
	// A newly activated ordinary User cannot process Registrations.
	for _, operation := range []struct {
		method, path string
		body         any
	}{
		{"GET", "/api/registrations", nil},
		{"POST", path, map[string]any{"organizationId": 1}},
		{"POST", fmt.Sprintf("/api/registrations/%d/reject", pending[0].ID), nil},
	} {
		if status, data := applicant.do(operation.method, operation.path, operation.body); status != 403 {
			t.Fatalf("ordinary User: %d %s", status, data)
		}
	}
	events := readAuditEvents(t, stores.config.DatabaseURL)
	n := 0
	for _, event := range events {
		if event.Action == "account_change" {
			if event.Outcome != "success" || event.UserID == nil || *event.UserID != administrator.Id {
				t.Fatalf("incorrect account audit: %+v", event)
			}
			n++
		}
	}
	if n != 2 {
		t.Fatalf("missing activation/rejection audit: %+v", events)
	}
}
