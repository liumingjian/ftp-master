//go:build integration

package app_test

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestRecycleSubtreeIsolationRestoreAndPurge(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	b := newBrowser(t, server)
	signInAsAdministrator(t, b)
	call := func(method, path string, body any, want int) []byte {
		t.Helper()
		status, data := b.do(method, path, body)
		if status != want {
			t.Fatalf("%s %s: %d %s", method, path, status, data)
		}
		return data
	}
	var parent, child struct {
		ID int64 `json:"id"`
	}
	decode(t, call("POST", "/api/tree", map[string]any{"name": "Recycle"}, 201), &parent)
	decode(t, call("POST", "/api/tree", map[string]any{"name": "Child", "parentId": parent.ID}, 201), &child)
	root := fmt.Sprintf("/api/tree/%d", parent.ID)
	nested := fmt.Sprintf("/api/tree/%d", child.ID)
	call("DELETE", root, nil, 204)
	call("GET", root, nil, 404)
	call("GET", nested, nil, 404)
	call("POST", root+"/restore", map[string]any{}, 204)
	call("GET", nested, nil, 200)
	call("DELETE", root, nil, 204)
	call("DELETE", root+"/purge", nil, 204)
	call("POST", root+"/restore", map[string]any{}, 404)
}

func TestRecycleCreatorOrParentDeleteAndOrphanRestore(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	admin := newBrowser(t, server)
	signInAsAdministrator(t, admin)
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stores.config.MigrationDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var userID int64
	err = conn.QueryRow(ctx, `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT 'creator','Creator',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`).Scan(&userID)
	if err != nil {
		t.Fatal(err)
	}
	creator := newBrowser(t, server)
	if status, _ := creator.signIn("creator", initialAdministratorPassword); status != 200 {
		t.Fatal(status)
	}
	call := func(b *browser, method, path string, body any, want int) []byte {
		t.Helper()
		status, data := b.do(method, path, body)
		if status != want {
			t.Fatalf("%s %s: %d %s", method, path, status, data)
		}
		return data
	}
	var dir, other struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/api/tree", map[string]any{"name": "Original"}, 201), &dir)
	decode(t, call(admin, "POST", "/api/tree", map[string]any{"name": "Destination"}, 201), &other)
	call(admin, "POST", fmt.Sprintf("/api/tree/%d/grants", dir.ID), map[string]any{"principalKind": "user", "principalId": userID, "rights": 5, "scope": "subtree"}, 201)
	var upload struct {
		ID string `json:"id"`
	}
	decode(t, call(creator, "POST", "/api/uploads", map[string]any{"parentId": dir.ID, "name": "created.docx", "size": 5}, 201), &upload)
	var urls []struct {
		URL string `json:"url"`
	}
	decode(t, call(creator, "POST", "/api/uploads/"+upload.ID+"/parts", map[string]any{"numbers": []int{1}}, 200), &urls)
	req, _ := http.NewRequest("PUT", urls[0].URL, strings.NewReader("hello"))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	var receipt struct {
		FileID int64 `json:"fileId"`
	}
	decode(t, call(creator, "POST", "/api/uploads/"+upload.ID+"/complete", nil, 200), &receipt)
	file := fmt.Sprintf("/api/tree/%d", receipt.FileID)
	parent := fmt.Sprintf("/api/tree/%d", dir.ID)
	var permit struct {
		Document string `json:"documentUrl"`
		Delivery string `json:"deliveryCheckUrl"`
	}
	decode(t, call(creator, "POST", fmt.Sprintf("/api/files/%d/office-edits", receipt.FileID), map[string]any{}, 201), &permit)
	call(admin, "DELETE", file, nil, 204)
	call(creator, "GET", permit.Document, nil, 404)
	call(creator, "GET", permit.Delivery, nil, 404)
	call(creator, "POST", "/api/uploads/"+upload.ID+"/complete", nil, 404)
	call(creator, "GET", file+"/download", nil, 404)
	call(creator, "POST", file+"/restore", map[string]any{}, 204)
	call(admin, "DELETE", file, nil, 204)
	call(creator, "DELETE", file+"/purge", nil, 403)
	call(admin, "DELETE", parent, nil, 204)
	call(admin, "DELETE", parent+"/purge", nil, 204)
	call(creator, "POST", file+"/restore", map[string]any{}, 409)
	call(admin, "POST", file+"/restore", map[string]any{"parentId": other.ID}, 204)
	call(admin, "DELETE", file, nil, 204)
	call(admin, "DELETE", file+"/purge", nil, 204)
	// Purge reaches real MinIO, while action histories remain addressable by stable ID.
	client, err := minio.New(stores.config.MinIOEndpoint, &minio.Options{Creds: credentials.NewStaticV4(stores.config.MinIOAccessKey, stores.config.MinIOSecretKey, "")})
	if err != nil {
		t.Fatal(err)
	}
	for obj := range client.ListObjects(ctx, stores.config.MinIOBucket, minio.ListObjectsOptions{Recursive: true}) {
		if obj.Err != nil {
			t.Fatal(obj.Err)
		}
		t.Fatalf("purge retained object %s", obj.Key)
	}
	for _, action := range []string{"delete", "restore", "purge"} {
		var count int
		err = conn.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE item_id=$1 AND action=$2", receipt.FileID, action).Scan(&count)
		if err != nil || count == 0 {
			t.Fatalf("audit %s: %d %v", action, count, err)
		}
	}
}
