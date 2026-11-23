//go:build integration

package app_test

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
)

func TestOfficeStartRequiresSessionAndFile(t *testing.T) {
	stores := startStores(t)
	fake := clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC))
	server := startService(t, stores.config, fake)
	b := newBrowser(t, server)
	if status, body := b.do("POST", "/api/files/999/office-edits", map[string]any{}); status != 401 {
		t.Fatalf("unauthenticated: %d %s", status, body)
	}
	signInAsAdministrator(t, b)
	if status, body := b.do("POST", "/api/files/999/office-edits", map[string]any{}); status != 404 {
		t.Fatalf("missing: %d %s", status, body)
	}
	conn, err := pgx.Connect(context.Background(), stores.config.MigrationDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	var adminID int64
	if err = conn.QueryRow(context.Background(), "SELECT id FROM users WHERE is_administrator LIMIT 1").Scan(&adminID); err != nil {
		t.Fatal(err)
	}
	fixture := func(name, format string, size int64) (int64, int64) {
		t.Helper()
		var file, version int64
		if err := conn.QueryRow(context.Background(), "INSERT INTO tree_nodes(name,is_file) VALUES($1,true) RETURNING id", name).Scan(&file); err != nil {
			t.Fatal(err)
		}
		if err := conn.QueryRow(context.Background(), "INSERT INTO file_versions(file_id,object_key,size,format,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id", file, name, size, format, adminID, fake.Now()).Scan(&version); err != nil {
			t.Fatal(err)
		}
		return file, version
	}
	for _, format := range []string{"doc", "docx", "wps", "xls", "xlsx"} {
		file, version := fixture("report."+format, format, 25*1024*1024)
		status, body := b.do("POST", fmt.Sprintf("/api/files/%d/office-edits", file), map[string]any{})
		if status != 201 {
			t.Fatalf("%s: %d %s", format, status, body)
		}
		var receipt struct {
			PermitID    string    `json:"permitId"`
			VersionID   int64     `json:"versionId"`
			DocumentURL string    `json:"documentUrl"`
			SaveURL     string    `json:"saveUrl"`
			DeliveryURL string    `json:"deliveryCheckUrl"`
			ExpiresAt   time.Time `json:"expiresAt"`
		}
		decode(t, body, &receipt)
		if receipt.PermitID == "" || receipt.VersionID != version || !receipt.ExpiresAt.Equal(fake.Now().Add(5*time.Minute)) {
			t.Fatalf("bad receipt: %s", body)
		}
		for _, raw := range []string{receipt.DocumentURL, receipt.SaveURL, receipt.DeliveryURL} {
			u, err := url.Parse(raw)
			if err != nil || u.User != nil || u.RawQuery != "" || !strings.Contains(u.Path, receipt.PermitID) {
				t.Fatalf("bad capability URL %s", raw)
			}
		}
		status, body = b.do("POST", fmt.Sprintf("/api/files/%d/office-edits", file), map[string]any{"versionId": version})
		if status != 201 {
			t.Fatalf("explicit: %d %s", status, body)
		}
		status, body = b.do("POST", fmt.Sprintf("/api/files/%d/office-edits", file), map[string]any{"versionId": 999999})
		if status != 404 {
			t.Fatalf("wrong version: %d %s", status, body)
		}
	}
	for _, tc := range []struct {
		format string
		size   int64
		want   int
	}{{"pdf", 1, 415}, {"docx", 25*1024*1024 + 1, 413}} {
		file, _ := fixture(fmt.Sprintf("bad-%s", tc.format), tc.format, tc.size)
		if status, body := b.do("POST", fmt.Sprintf("/api/files/%d/office-edits", file), map[string]any{}); status != tc.want {
			t.Fatalf("refusal: %d %s", status, body)
		}
	}
	// A different signed-in User cannot start an edit on an invisible file.
	var userID int64
	err = conn.QueryRow(context.Background(), `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT 'office-reader','Reader',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`).Scan(&userID)
	if err != nil {
		t.Fatal(err)
	}
	reader := newBrowser(t, server)
	if status, _ := reader.signIn("office-reader", initialAdministratorPassword); status != 200 {
		t.Fatal(status)
	}
	file, version := fixture("restricted.docx", "docx", 1)
	route := fmt.Sprintf("/api/files/%d/office-edits", file)
	if status, body := reader.do("POST", route, map[string]any{}); status != 404 {
		t.Fatalf("invisible: %d %s", status, body)
	}
	if _, err = conn.Exec(context.Background(), "INSERT INTO grants(node_id,principal_kind,principal_id,rights,scope) VALUES($1,'user',$2,1,'subtree')", file, userID); err != nil {
		t.Fatal(err)
	}
	if status, body := reader.do("POST", route, map[string]any{}); status != 403 {
		t.Fatalf("browse only: %d %s", status, body)
	}
	status, body := reader.do("POST", route, map[string]any{"preview": true})
	if status != 201 {
		t.Fatalf("browse-only preview: %d", status)
	}
	var preview map[string]any
	decode(t, body, &preview)
	if _, canSave := preview["saveUrl"]; canSave {
		t.Fatal("preview returned a save URL")
	}
	if status, _ := reader.do("PUT", "/api/office-edit-policy", map[string]any{"enabled": false}); status != 403 {
		t.Fatalf("non-admin policy change: %d", status)
	}
	if status, _ := b.do("PUT", "/api/office-edit-policy", map[string]any{}); status != 400 {
		t.Fatalf("omitted enabled: %d", status)
	}
	if status, _ := b.do("PUT", "/api/office-edit-policy", map[string]any{"enabled": false}); status != 200 {
		t.Fatalf("disable editing: %d", status)
	}
	if status, _ := b.do("POST", route, map[string]any{}); status != 403 {
		t.Fatalf("disabled editing: %d", status)
	}
	if status, _ := reader.do("POST", route, map[string]any{"preview": true}); status != 201 {
		t.Fatalf("preview with editing disabled: %d", status)
	}
	if status, _ := b.do("PUT", "/api/office-edit-policy", map[string]any{"enabled": true}); status != 200 {
		t.Fatalf("enable editing: %d", status)
	}
	// Latest selection differs from explicit historical selection.
	var latest int64
	if err = conn.QueryRow(context.Background(), "INSERT INTO file_versions(file_id,object_key,size,format,created_by,created_at) VALUES($1,'new-version',1,'docx',$2,$3) RETURNING id", file, adminID, fake.Now()).Scan(&latest); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		body any
		want int64
	}{{map[string]any{}, latest}, {map[string]any{"versionId": version}, version}} {
		status, body := b.do("POST", route, tc.body)
		if status != 201 {
			t.Fatalf("selection: %d %s", status, body)
		}
		var got struct {
			ID int64 `json:"versionId"`
		}
		decode(t, body, &got)
		if got.ID != tc.want {
			t.Fatalf("selected %d want %d", got.ID, tc.want)
		}
	}

	count := 0
	for _, event := range readAuditEvents(t, stores.config.DatabaseURL) {
		if event.Action == "open_for_edit" {
			count++
		}
	}
	if count != 12 {
		t.Fatalf("open-for-edit audit events %d", count)
	}
}
