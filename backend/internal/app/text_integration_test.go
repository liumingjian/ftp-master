//go:build integration

package app_test

import (
	"bytes"
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"strings"
	"testing"
	"time"
)

func TestTextEditingVersionsAndConflict(t *testing.T) {
	stores := startStores(t)
	fake := clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC))
	server := startService(t, stores.config, fake)
	owner := newBrowser(t, server)
	signInAsAdministrator(t, owner)
	conn, err := pgx.Connect(context.Background(), stores.config.MigrationDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	client, err := minio.New(stores.config.MinIOEndpoint, &minio.Options{Creds: credentials.NewStaticV4(stores.config.MinIOAccessKey, stores.config.MinIOSecretKey, "")})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	var file int64
	if err = conn.QueryRow(ctx, "INSERT INTO tree_nodes(name,is_file) VALUES('edit.txt',true) RETURNING id").Scan(&file); err != nil {
		t.Fatal(err)
	}
	if _, err = client.PutObject(ctx, stores.config.MinIOBucket, "original-text", bytes.NewBufferString("original"), 8, minio.PutObjectOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, "INSERT INTO file_versions(file_id,object_key,size,format,created_by,created_at) SELECT $1,'original-text',8,'txt',id,$2 FROM users WHERE is_administrator LIMIT 1", file, fake.Now()); err != nil {
		t.Fatal(err)
	}
	path := fmt.Sprintf("/api/tree/%d/text", file)
	status, data := owner.do("GET", path, nil)
	if status != 200 {
		t.Fatalf("open %d %s", status, data)
	}
	var opened struct {
		VersionID int64  `json:"versionId"`
		Content   string `json:"content"`
	}
	decode(t, data, &opened)
	if opened.Content != "original" {
		t.Fatal(string(data))
	}
	originalID := opened.VersionID
	body := map[string]any{"baseVersionId": originalID, "content": "edited 中文"}
	if status, data = owner.do("PUT", path, body); status != 201 {
		t.Fatalf("save %d %s", status, data)
	}
	if status, data = owner.do("PUT", path, body); status != 409 {
		t.Fatalf("conflict %d %s", status, data)
	}
	status, data = owner.do("GET", path, nil)
	decode(t, data, &opened)
	if opened.Content != "edited 中文" {
		t.Fatal(string(data))
	}
	status, data = owner.do("GET", fmt.Sprintf("/api/tree/%d/versions", file), nil)
	var versions []struct {
		ID int64 `json:"id"`
	}
	decode(t, data, &versions)
	if status != 200 || len(versions) != 2 {
		t.Fatalf("versions %d %s", status, data)
	}
	if status, data = owner.do("POST", fmt.Sprintf("/api/tree/%d/versions/%d/restore", file, originalID), nil); status != 201 {
		t.Fatalf("restore %d %s", status, data)
	}
	status, data = owner.do("GET", path, nil)
	decode(t, data, &opened)
	if opened.Content != "original" {
		t.Fatal(string(data))
	}
	if status, _ = owner.do("PUT", path, map[string]any{"baseVersionId": opened.VersionID, "content": strings.Repeat("x", 10000000)}); status != 413 {
		t.Fatalf("oversize %d", status)
	}
	// Rejecting the required Audit Event must roll back the published version.
	if _, err = conn.Exec(ctx, `CREATE FUNCTION reject_text_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='text_save' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_text_save BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_text_save()`); err != nil {
		t.Fatal(err)
	}
	if status, _ = owner.do("PUT", path, map[string]any{"baseVersionId": opened.VersionID, "content": "must rollback"}); status != 500 {
		t.Fatalf("audit rollback %d", status)
	}
	if _, err = conn.Exec(ctx, "DROP TRIGGER reject_text_save ON audit_events; DROP FUNCTION reject_text_save()"); err != nil {
		t.Fatal(err)
	}
	status, data = owner.do("GET", path, nil)
	decode(t, data, &opened)
	if opened.Content != "original" {
		t.Fatalf("rollback changed bytes %s", data)
	}
	// Current rights are checked again at save, rather than trusted from open.
	var readerID int64
	if err = conn.QueryRow(ctx, `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT 'text-reader','Reader',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`).Scan(&readerID); err != nil {
		t.Fatal(err)
	}
	reader := newBrowser(t, server)
	if status, _ = reader.signIn("text-reader", initialAdministratorPassword); status != 200 {
		t.Fatal(status)
	}
	if _, err = conn.Exec(ctx, "INSERT INTO grants(node_id,principal_kind,principal_id,rights,scope) VALUES($1,'user',$2,3,'subtree')", file, readerID); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GET", "PUT"} {
		if status, _ = reader.do(method, path, map[string]any{"baseVersionId": opened.VersionID, "content": "denied"}); status != 403 {
			t.Fatalf("Modify required %s: %d", method, status)
		}
	}

	for _, action := range []string{"text_open", "text_save"} {
		status, data = owner.do("POST", "/api/audit/query", map[string]any{"from": "2026-11-19T00:00:00Z", "to": "2026-11-20T00:00:00Z", "action": action})
		if status != 200 || !bytes.Contains(data, []byte(action)) {
			t.Fatalf("missing audit %s: %d %s", action, status, data)
		}
	}
	// Seed independent invalid and boundary files; observe rejection only over HTTP.
	for _, tc := range []struct {
		name, format string
		content      []byte
		size         int64
		want         int
	}{
		{"binary", "txt", []byte{0xff}, 1, 415},
		{"unsupported", "png", []byte("abc"), 3, 415},
		{"boundary", "txt", nil, 10000000, 413},
	} {
		var id int64
		if err = conn.QueryRow(ctx, "INSERT INTO tree_nodes(name,is_file) VALUES($1,true) RETURNING id", tc.name+"."+tc.format).Scan(&id); err != nil {
			t.Fatal(err)
		}
		key := "text-" + tc.name
		if _, err = client.PutObject(ctx, stores.config.MinIOBucket, key, bytes.NewReader(tc.content), int64(len(tc.content)), minio.PutObjectOptions{}); err != nil {
			t.Fatal(err)
		}
		if _, err = conn.Exec(ctx, "INSERT INTO file_versions(file_id,object_key,size,format,created_by,created_at) SELECT $1,$2,$3,$4,id,$5 FROM users WHERE is_administrator LIMIT 1", id, key, tc.size, tc.format, fake.Now()); err != nil {
			t.Fatal(err)
		}
		if status, data = owner.do("GET", fmt.Sprintf("/api/tree/%d/text", id), nil); status != tc.want {
			t.Fatalf("%s: %d %s", tc.name, status, data)
		}
	}

	status, data = owner.do("POST", "/api/audit/query", map[string]any{"from": "2026-11-19T00:00:00Z", "to": "2026-11-20T00:00:00Z", "action": "text_save"})
	if status != 200 || !bytes.Contains(data, []byte("text_save")) {
		t.Fatalf("audit %d %s", status, data)
	}
}
