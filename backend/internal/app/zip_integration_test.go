//go:build integration

package app_test

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"testing"
	"time"
)

func TestZIPDownloadFiltersFilesAndAuditsOnce(t *testing.T) {
	stores := startStores(t)
	fake := clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC))
	server := startService(t, stores.config, fake)
	admin := newBrowser(t, server)
	signInAsAdministrator(t, admin)
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stores.config.MigrationDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var user, folder, allowed int64
	if err = conn.QueryRow(ctx, `INSERT INTO users(username,display_name,password_hash,status,created_at) SELECT 'zip-reader','Reader',password_hash,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`).Scan(&user); err != nil {
		t.Fatal(err)
	}
	reader := newBrowser(t, server)
	if status, _ := reader.signIn("zip-reader", initialAdministratorPassword); status != 200 {
		t.Fatal(status)
	}
	if err = conn.QueryRow(ctx, `INSERT INTO tree_nodes(name,is_file) VALUES('Folder',false) RETURNING id`).Scan(&folder); err != nil {
		t.Fatal(err)
	}
	client, err := minio.New(stores.config.MinIOEndpoint, &minio.Options{Creds: credentials.NewStaticV4(stores.config.MinIOAccessKey, stores.config.MinIOSecretKey, "")})
	if err != nil {
		t.Fatal(err)
	}
	for i, name := range []string{"allowed.txt", "denied.txt"} {
		var id int64
		if err = conn.QueryRow(ctx, `INSERT INTO tree_nodes(name,is_file,parent_id) VALUES($1,true,$2) RETURNING id`, name, folder).Scan(&id); err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			allowed = id
		}
		key := fmt.Sprintf("zip-%d", id)
		content := []byte(name)
		if _, err = client.PutObject(ctx, stores.config.MinIOBucket, key, bytes.NewReader(content), int64(len(content)), minio.PutObjectOptions{}); err != nil {
			t.Fatal(err)
		}
		if _, err = conn.Exec(ctx, `INSERT INTO file_versions(file_id,object_key,size,format,created_by,created_at) SELECT $1,$2,$3,'txt',id,$4 FROM users WHERE is_administrator LIMIT 1`, id, key, len(content), fake.Now()); err != nil {
			t.Fatal(err)
		}
		rights := 1
		if i == 0 {
			rights = 3
		}
		if _, err = conn.Exec(ctx, `INSERT INTO grants(node_id,principal_kind,principal_id,rights,scope) VALUES($1,'user',$2,$3,'subtree')`, id, user, rights); err != nil {
			t.Fatal(err)
		}
	}
	path := fmt.Sprintf("/api/tree/zip?ids=%d,%d", folder, allowed)
	if status, _ := reader.do("GET", path+"&preflight=true", nil); status != 204 {
		t.Fatalf("preflight %d", status)
	}
	status, data := reader.do("GET", path, nil)
	if status != 200 {
		t.Fatalf("zip %d %s", status, data)
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	if len(archive.File) != 1 || archive.File[0].Name != "Folder/allowed.txt" {
		t.Fatalf("entries %v", archive.File)
	}
	var count int
	var detail string
	if err = conn.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action='zip_download'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("audit %d %v", count, err)
	}
	if err = conn.QueryRow(ctx, `SELECT detail::text FROM audit_events WHERE action='zip_download'`).Scan(&detail); err != nil {
		t.Fatal(err)
	}
	var event struct {
		Files []struct {
			ID   int64
			Path string
		}
	}
	decode(t, []byte(detail), &event)
	if len(event.Files) != 1 || event.Files[0].ID != allowed || event.Files[0].Path != "/Folder/allowed.txt" {
		t.Fatal(detail)
	}
	if _, err = conn.Exec(ctx, `UPDATE file_versions SET size=10000000001 WHERE file_id=$1`, allowed); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", "&preflight=true"} {
		if status, _ := reader.do("GET", path+suffix, nil); status != 413 {
			t.Fatalf("oversize %d", status)
		}
	}
}
