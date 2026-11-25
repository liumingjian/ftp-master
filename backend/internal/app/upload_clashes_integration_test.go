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
		req, _ := http.NewRequest("PUT", server.URL+urls[0].URL, bytes.NewBufferString(content))
		req.AddCookie(b.cookie)
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
	// Version history is public metadata; restoration appends instead of rewriting.
	historyPath := fmt.Sprintf("/api/tree/%d/versions", original.FileID)
	var history []struct {
		ID        int64     `json:"id"`
		Username  string    `json:"username"`
		CreatedAt time.Time `json:"createdAt"`
	}
	decode(t, call("GET", historyPath, nil, 200), &history)
	if len(history) != 2 || history[0].ID != replacement.VersionID || history[1].ID != original.VersionID || history[0].Username == "" || history[0].CreatedAt.IsZero() {
		t.Fatalf("history: %+v", history)
	}
	var readerID int64
	err = conn.QueryRow(context.Background(), `INSERT INTO users(username,display_name,password_hash,status,created_at) SELECT 'history-reader','Reader',password_hash,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`).Scan(&readerID)
	if err != nil {
		t.Fatal(err)
	}
	historyReader := newBrowser(t, server)
	if status, _ := historyReader.signIn("history-reader", initialAdministratorPassword); status != 200 {
		t.Fatal(status)
	}
	if status, _ := historyReader.do("GET", historyPath, nil); status != 404 {
		t.Fatalf("hidden history: %d", status)
	}
	grantPath := fmt.Sprintf("/api/tree/%d/grants", original.FileID)
	call("POST", grantPath, map[string]any{"principalKind": "user", "principalId": readerID, "rights": 1, "scope": "subtree"}, 201)
	if status, _ := historyReader.do("GET", historyPath, nil); status != 200 {
		t.Fatalf("Browse history: %d", status)
	}
	if status, _ := historyReader.do("POST", fmt.Sprintf("%s/%d/restore", historyPath, original.VersionID), nil); status != 403 {
		t.Fatalf("Browse restore: %d", status)
	}
	if status, _ := historyReader.do("GET", fmt.Sprintf("/api/tree/%d/download?versionId=%d", original.FileID, original.VersionID), nil); status != 403 {
		t.Fatalf("Browse download: %d", status)
	}
	call("POST", fmt.Sprintf("%s/%d/restore", historyPath, 99999999), nil, 404)

	// A failed Audit Event must roll back the appended File Version.
	_, err = conn.Exec(context.Background(), `CREATE FUNCTION refuse_restore_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='restore_version' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_restore_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION refuse_restore_audit()`)
	if err != nil {
		t.Fatal(err)
	}
	call("POST", fmt.Sprintf("%s/%d/restore", historyPath, original.VersionID), nil, 500)
	_, err = conn.Exec(context.Background(), "DROP TRIGGER refuse_restore_audit ON audit_events")
	if err != nil {
		t.Fatal(err)
	}
	decode(t, call("GET", historyPath, nil, 200), &history)
	if len(history) != 2 {
		t.Fatal("failed audit left a version")
	}

	var restored struct {
		FileId    int64 `json:"fileId"`
		VersionId int64 `json:"versionId"`
	}
	decode(t, call("POST", fmt.Sprintf("%s/%d/restore", historyPath, original.VersionID), nil, 201), &restored)
	if restored.FileId != original.FileID || restored.VersionId <= replacement.VersionID {
		t.Fatalf("restore: %+v", restored)
	}
	decode(t, call("GET", historyPath, nil, 200), &history)
	if len(history) != 3 || history[0].ID != restored.VersionId {
		t.Fatalf("restored history: %+v", history)
	}
	req, _ := http.NewRequest("GET", fmt.Sprintf("%s/api/tree/%d/download", server.URL, original.FileID), nil)
	req.AddCookie(b.cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	restoredBytes, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(restoredBytes) != "first" {
		t.Fatalf("restored bytes: %s", restoredBytes)
	}

	// Historical download remains immutable after restoration.
	req, _ = http.NewRequest("GET", fmt.Sprintf("%s/api/tree/%d/download?versionId=%d", server.URL, original.FileID, replacement.VersionID), nil)
	req.AddCookie(b.cookie)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	priorBytes, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(priorBytes) != "second" {
		t.Fatalf("prior version changed: %s", priorBytes)
	}
	restores := 0
	for _, event := range readAuditEvents(t, stores.config.DatabaseURL) {
		if event.Action == "restore_version" {
			restores++
		}
	}
	if restores != 1 {
		t.Fatalf("restore audit count: %d", restores)
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
