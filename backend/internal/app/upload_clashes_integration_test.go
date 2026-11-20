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
	"testing"
	"time"
)

func TestUploadClashesPreserveVersionsAndKeepBoth(t *testing.T) {
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
	conn, err := pgx.Connect(context.Background(), stores.config.MigrationDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call("POST", "/api/tree", map[string]any{"name": "Clashes"}, 201), &dir)
	upload := func(content string) string {
		t.Helper()
		var session struct {
			ID string `json:"id"`
		}
		decode(t, call("POST", "/api/uploads", map[string]any{"parentId": dir.ID, "name": "same.txt", "size": len(content)}, 201), &session)
		var urls []struct {
			URL string `json:"url"`
		}
		decode(t, call("POST", "/api/uploads/"+session.ID+"/parts", map[string]any{"numbers": []int{1}}, 200), &urls)
		req, _ := http.NewRequest("PUT", urls[0].URL, bytes.NewBufferString(content))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatal(res.StatusCode)
		}
		return "/api/uploads/" + session.ID + "/complete"
	}
	var original, replacement, renamed struct {
		FileID    int64 `json:"fileId"`
		VersionID int64 `json:"versionId"`
	}
	decode(t, call("POST", upload("first"), nil, 200), &original)
	path := upload("second")
	call("POST", path, nil, 409)
	_, err = conn.Exec(context.Background(), `CREATE FUNCTION refuse_clash_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected metadata failure'; END $$; CREATE TRIGGER refuse_clash_version BEFORE INSERT ON file_versions FOR EACH ROW EXECUTE FUNCTION refuse_clash_version()`)
	if err != nil {
		t.Fatal(err)
	}
	call("POST", path+"?collision=new_version", nil, 500)
	_, err = conn.Exec(context.Background(), "DROP TRIGGER refuse_clash_version ON file_versions")
	if err != nil {
		t.Fatal(err)
	}
	// The selection and completed object survive failed metadata publication.
	receipt := call("POST", path, nil, 200)

	decode(t, receipt, &replacement)
	if original.FileID != replacement.FileID || original.VersionID == replacement.VersionID {
		t.Fatal("overwrite must append a version", original, replacement)
	}
	if !bytes.Equal(receipt, call("POST", path, nil, 200)) {
		t.Fatal("retry changed receipt")
	}
	decode(t, call("POST", upload("third")+"?collision=keep_both", nil, 200), &renamed)
	if renamed.FileID == original.FileID {
		t.Fatal("keep both reused file")
	}
	var node struct {
		Name string `json:"name"`
	}
	decode(t, call("GET", fmt.Sprintf("/api/tree/%d", renamed.FileID), nil, 200), &node)
	if node.Name != "same (1).txt" {
		t.Fatal(node.Name)
	}
	client, err := minio.New(stores.config.MinIOEndpoint, &minio.Options{Creds: credentials.NewStaticV4(stores.config.MinIOAccessKey, stores.config.MinIOSecretKey, "")})
	if err != nil {
		t.Fatal(err)
	}
	contents := map[string]bool{}
	for object := range client.ListObjects(context.Background(), stores.config.MinIOBucket, minio.ListObjectsOptions{}) {
		if object.Err != nil {
			t.Fatal(object.Err)
		}
		obj, err := client.GetObject(context.Background(), stores.config.MinIOBucket, object.Key, minio.GetObjectOptions{})
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(obj)
		obj.Close()
		if err != nil {
			t.Fatal(err)
		}
		contents[string(data)] = true
	}
	if !contents["first"] || !contents["second"] || !contents["third"] {
		t.Fatal(contents)
	}
	var userID int64
	err = conn.QueryRow(context.Background(), `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT 'dropper','Dropper',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`).Scan(&userID)
	if err != nil {
		t.Fatal(err)
	}
	call("POST", fmt.Sprintf("/api/tree/%d/grants", dir.ID), map[string]any{"principalKind": "user", "principalId": userID, "rights": 4, "scope": "subtree"}, 201)
	reader := newBrowser(t, server)
	if status, _ := reader.signIn("dropper", initialAdministratorPassword); status != 200 {
		t.Fatal(status)
	}
	b = reader
	listing := call("GET", fmt.Sprintf("/api/tree?parentId=%d", dir.ID), nil, 200)
	if bytes.Contains(listing, []byte("same.txt")) {
		t.Fatal("Drop Box listed hidden file", string(listing))
	}
	call("GET", fmt.Sprintf("/api/tree/%d", original.FileID), nil, 404)
	var hidden struct {
		FileID int64 `json:"fileId"`
	}
	decode(t, call("POST", upload("dropbox")+"?collision=new_version", nil, 200), &hidden)
	if hidden.FileID == original.FileID {
		t.Fatal("hidden file overwritten")
	}
	call("GET", fmt.Sprintf("/api/tree/%d", original.FileID), nil, 404)

	uploads := 0
	for _, e := range readAuditEvents(t, stores.config.DatabaseURL) {
		if e.Action == "upload" {
			uploads++
		}
	}
	if uploads != 4 {
		t.Fatal("audit events", uploads)
	}
}
