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
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestSearchRequiresSignInAndMatchesFileNames(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	b := newBrowser(t, server)
	if status, _ := b.do("GET", "/api/tree/search?q=report", nil); status != 401 {
		t.Fatalf("anonymous search: %d", status)
	}
	signInAsAdministrator(t, b)
	if status, data := b.do("GET", "/api/tree/search?q=report", nil); status != 200 || string(data) != "[]\n" {
		t.Fatalf("search: %d %s", status, data)
	}
}

func TestBrowsePreviewSearchAndStableLinks(t *testing.T) {
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
	mustExec := func(sql string, args ...any) {
		t.Helper()
		if _, err := conn.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	var readerID, parent, deep int64
	if err := conn.QueryRow(ctx, `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT 'preview-reader','Reader',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`).Scan(&readerID); err != nil {
		t.Fatal(err)
	}
	reader := newBrowser(t, server)
	if status, _ := reader.signIn("preview-reader", initialAdministratorPassword); status != 200 {
		t.Fatal(status)
	}
	if err := conn.QueryRow(ctx, `INSERT INTO tree_nodes(name,is_file) VALUES('hidden-parent',false) RETURNING id`).Scan(&parent); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `INSERT INTO tree_nodes(name,is_file,parent_id) VALUES('deep',false,$1) RETURNING id`, parent).Scan(&deep); err != nil {
		t.Fatal(err)
	}
	client, err := minio.New(stores.config.MinIOEndpoint, &minio.Options{Creds: credentials.NewStaticV4(stores.config.MinIOAccessKey, stores.config.MinIOSecretKey, "")})
	if err != nil {
		t.Fatal(err)
	}
	var visible []int64
	for _, format := range []string{"png", "pdf", "txt", "mp3", "mp4", "html", "svg"} {
		var id int64
		if err := conn.QueryRow(ctx, `INSERT INTO tree_nodes(name,is_file,parent_id) VALUES($1,true,$2) RETURNING id`, "Report."+format, deep).Scan(&id); err != nil {
			t.Fatal(err)
		}
		key := fmt.Sprintf("preview-%d", id)
		content := []byte("0123456789<script>alert(1)</script>")
		if _, err := client.PutObject(ctx, stores.config.MinIOBucket, key, bytes.NewReader(content), int64(len(content)), minio.PutObjectOptions{}); err != nil {
			t.Fatal(err)
		}
		mustExec(`INSERT INTO file_versions(file_id,object_key,size,format,created_by,created_at) SELECT $1,$2,$3,$4,id,$5 FROM users WHERE is_administrator LIMIT 1`, id, key, len(content), format, fake.Now())
		mustExec(`INSERT INTO grants(node_id,principal_kind,principal_id,rights,scope) VALUES($1,'user',$2,1,'subtree')`, id, readerID)
		visible = append(visible, id)
	}
	var hidden int64
	if err := conn.QueryRow(ctx, `INSERT INTO tree_nodes(name,is_file,parent_id) VALUES('Report.hidden',true,$1) RETURNING id`, deep).Scan(&hidden); err != nil {
		t.Fatal(err)
	}
	status, data := reader.do("GET", "/api/tree/search?q=rEpOrT", nil)
	if status != 200 {
		t.Fatalf("search %d %s", status, data)
	}
	var results []struct {
		ID int64 `json:"id"`
	}
	decode(t, data, &results)
	if len(results) != 7 {
		t.Fatalf("search leaked or missed: %s", data)
	}
	for _, n := range results {
		if n.ID == hidden {
			t.Fatal("hidden search result")
		}
	}
	for _, path := range []string{fmt.Sprintf("/api/tree/%d", hidden), fmt.Sprintf("/api/tree/%d/preview", hidden)} {
		if status, _ := reader.do("GET", path, nil); status != 404 {
			t.Fatalf("hidden %s: %d", path, status)
		}
	}
	for i, id := range visible {
		path := fmt.Sprintf("/api/tree/%d", id)
		if status, _ := reader.do("GET", path, nil); status != 200 {
			t.Fatalf("stable link %d", status)
		}
		if status, _ := reader.do("GET", path+"/download", nil); status != 403 {
			t.Fatalf("Browse granted Download: %d", status)
		}
		req, _ := http.NewRequest("GET", server.URL+path+"/preview", nil)
		req.AddCookie(reader.cookie)
		if i == 3 || i == 4 {
			req.Header.Set("Range", "bytes=2-5")
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		want := 200
		if i == 3 || i == 4 {
			want = 206
		}
		if i >= 5 {
			want = 415
		}
		if res.StatusCode != want {
			t.Fatalf("preview %d: %d %s", id, res.StatusCode, body)
		}
		if want == 206 && (string(body) != "2345" || res.Header.Get("Content-Range") != "bytes 2-5/35") {
			t.Fatalf("range: %q %v", body, res.Header)
		}
		if want < 400 && (res.Header.Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(res.Header.Get("Content-Security-Policy"), "default-src 'none'")) {
			t.Fatal("unsafe preview headers")
		}
	}
	// Rename and moving metadata never changes the identity used in copied links.
	mustExec(`UPDATE tree_nodes SET name='renamed.txt',parent_id=$2 WHERE id=$1`, visible[2], parent)
	if status, _ := reader.do("GET", fmt.Sprintf("/api/tree/%d", visible[2]), nil); status != 200 {
		t.Fatalf("renamed link %d", status)
	}
	var count int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action IN ('preview','download')`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("read flows audited: %d", count)
	}
	mustExec(`DELETE FROM grants WHERE principal_id=$1 AND principal_kind='user'`, readerID)
	if status, _ := reader.do("GET", fmt.Sprintf("/api/tree/%d/preview", visible[0]), nil); status != 404 {
		t.Fatalf("revocation: %d", status)
	}
}
