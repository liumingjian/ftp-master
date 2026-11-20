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

func TestUploadPolicyRejectsBeforeStorage(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	b := newBrowser(t, server)
	signInAsAdministrator(t, b)
	status, data := b.do("POST", "/api/tree", map[string]any{"name": "Uploads"})
	if status != 201 {
		t.Fatalf("%d %s", status, data)
	}
	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, data, &dir)
	for _, name := range []string{"virus.exe", "../bad.txt"} {
		status, data = b.do("POST", "/api/uploads", map[string]any{"parentId": dir.ID, "name": name, "size": 10})
		if status != 400 {
			t.Fatalf("%s: %d %s", name, status, data)
		}
	}
	status, data = b.do("POST", "/api/uploads", map[string]any{"parentId": dir.ID, "name": "large.txt", "size": 20000000001})
	if status != 400 {
		t.Fatalf("oversize: %d %s", status, data)
	}
}

func TestMultipartPublishesOnceWithCreatorAndExactBytes(t *testing.T) {
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
	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call("POST", "/api/tree", map[string]any{"name": "Files"}, 201), &dir)
	content := bytes.Repeat([]byte("abc123XY"), 1024*1024+3)
	var upload struct {
		ID        string `json:"id"`
		PartSize  int64  `json:"partSize"`
		PartCount int    `json:"partCount"`
	}
	decode(t, call("POST", "/api/uploads", map[string]any{"parentId": dir.ID, "name": "report.txt", "size": len(content)}, 201), &upload)
	call("POST", "/api/uploads/"+upload.ID+"/complete", nil, 409)
	var urls []struct {
		Number int    `json:"number"`
		URL    string `json:"url"`
	}
	decode(t, call("POST", "/api/uploads/"+upload.ID+"/parts", map[string]any{"numbers": []int{1, 2}}, 200), &urls)
	// Resume asks storage which parts survived, rather than trusting browser progress.
	var resumed []struct {
		Number int    `json:"number"`
		URL    string `json:"url"`
	}
	decode(t, call("GET", "/api/uploads/"+upload.ID+"/parts", nil, 200), &resumed)
	if len(resumed) != 0 {
		t.Fatal("new upload has stored parts")
	}
	for _, part := range urls {
		start := int64(part.Number-1) * upload.PartSize
		end := min(start+upload.PartSize, int64(len(content)))
		req, _ := http.NewRequest("PUT", part.URL, bytes.NewReader(content[start:end]))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("part: %d %s", res.StatusCode, body)
		}
	}
	decode(t, call("GET", "/api/uploads/"+upload.ID+"/parts", nil, 200), &resumed)
	if len(resumed) != 2 || resumed[0].Number != 1 || resumed[1].Number != 2 {
		t.Fatalf("stored parts: %v", resumed)
	}
	// Force metadata rollback after storage completion; retry must recover the
	// completed immutable object and publish exactly once.
	conn, err := pgx.Connect(context.Background(), stores.config.MigrationDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	_, err = conn.Exec(context.Background(), `CREATE FUNCTION refuse_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected metadata failure'; END $$; CREATE TRIGGER refuse_version BEFORE INSERT ON file_versions FOR EACH ROW EXECUTE FUNCTION refuse_version()`)
	if err != nil {
		t.Fatal(err)
	}
	call("POST", "/api/uploads/"+upload.ID+"/complete", nil, 500)
	_, err = conn.Exec(context.Background(), "DROP TRIGGER refuse_version ON file_versions")
	if err != nil {
		t.Fatal(err)
	}
	receipt := call("POST", "/api/uploads/"+upload.ID+"/complete", nil, 200)
	if got := call("POST", "/api/uploads/"+upload.ID+"/complete", nil, 200); !bytes.Equal(receipt, got) {
		t.Fatalf("different receipt: %s %s", receipt, got)
	}
	var published struct {
		FileID int64 `json:"fileId"`
	}
	decode(t, receipt, &published)
	var grants []struct {
		Creator bool `json:"creator"`
		Rights  int  `json:"rights"`
	}
	decode(t, call("GET", fmt.Sprintf("/api/tree/%d/grants", published.FileID), nil, 200), &grants)
	if len(grants) != 1 || !grants[0].Creator || grants[0].Rights != 63 {
		t.Fatalf("Creator Grant %v", grants)
	}
	// The redirect is an authorized issuance; the client then reads exact immutable bytes.
	downloadPath := fmt.Sprintf("/api/tree/%d/download", published.FileID)
	req, _ := http.NewRequest("GET", server.URL+downloadPath, nil)
	req.AddCookie(b.cookie)
	redirectClient := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := redirectClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 302 || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("redirect: %d", res.StatusCode)
	}
	downloaded, err := http.Get(res.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	gotBytes, _ := io.ReadAll(downloaded.Body)
	downloaded.Body.Close()
	if downloaded.StatusCode != 200 || !bytes.Equal(gotBytes, content) || !strings.Contains(downloaded.Header.Get("Content-Disposition"), "report.txt") {
		t.Fatal("download bytes or filename mismatch")
	}
	downloadEvents := 0
	for _, event := range readAuditEvents(t, stores.config.DatabaseURL) {
		if event.Action == "download" {
			downloadEvents++
		}
	}
	if downloadEvents != 1 {
		t.Fatalf("download events: %d", downloadEvents)
	}
	// Current permissions govern every issuance, including requested historical versions.
	var readerID int64
	err = conn.QueryRow(context.Background(), `INSERT INTO users(username,display_name,password_hash,status,created_at) SELECT 'download-reader','Reader',password_hash,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`).Scan(&readerID)
	if err != nil {
		t.Fatal(err)
	}
	reader := newBrowser(t, server)
	if status, _ := reader.signIn("download-reader", initialAdministratorPassword); status != 200 {
		t.Fatal(status)
	}
	if status, _ := reader.do("GET", downloadPath, nil); status != 404 {
		t.Fatalf("invisible: %d", status)
	}
	call("POST", fmt.Sprintf("/api/tree/%d/grants", published.FileID), map[string]any{"principalKind": "user", "principalId": readerID, "rights": 1, "scope": "subtree"}, 201)
	if status, _ := reader.do("GET", downloadPath, nil); status != 403 {
		t.Fatalf("Browse only: %d", status)
	}
	if status, _ := b.do("GET", downloadPath+"?versionId=99999999", nil); status != 404 {
		t.Fatalf("missing version: %d", status)
	}
	if status, _ := b.do("GET", fmt.Sprintf("/api/tree/%d/download", dir.ID), nil); status != 409 {
		t.Fatalf("directory: %d", status)
	}
	// Objects are an explicitly agreed observable transfer seam.

	// No metadata-table assertions.
	client, err := minio.New(stores.config.MinIOEndpoint, &minio.Options{Creds: credentials.NewStaticV4(stores.config.MinIOAccessKey, stores.config.MinIOSecretKey, "")})
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for object := range client.ListObjects(context.Background(), stores.config.MinIOBucket, minio.ListObjectsOptions{}) {
		if object.Err != nil {
			t.Fatal(object.Err)
		}
		count++
		if strings.Contains(object.Key, ".") {
			t.Fatal("mutable filename used as key")
		}
		obj, err := client.GetObject(context.Background(), stores.config.MinIOBucket, object.Key, minio.GetObjectOptions{})
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(obj)
		obj.Close()
		if err != nil || !bytes.Equal(got, content) {
			t.Fatal("content mismatch", err)
		}
	}
	if count != 1 {
		t.Fatalf("objects %d", count)
	}
	events := 0
	for _, event := range readAuditEvents(t, stores.config.DatabaseURL) {
		if event.Action == "upload" {
			events++
		}
	}
	if events != 1 {
		t.Fatalf("upload events %d", events)
	}
}

func TestEmptyUploadAndConcurrentFinish(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	b := newBrowser(t, server)
	signInAsAdministrator(t, b)
	call := func(method, path string, body any, want int) []byte {
		t.Helper()
		status, data := b.do(method, path, body)
		if status != want {
			t.Fatalf("%d %s", status, data)
		}
		return data
	}
	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call("POST", "/api/tree", map[string]any{"name": "Empty"}, 201), &dir)
	var upload struct {
		ID string `json:"id"`
	}
	decode(t, call("POST", "/api/uploads", map[string]any{"parentId": dir.ID, "name": "empty.txt", "size": 0}, 201), &upload)
	var urls []struct {
		URL string `json:"url"`
	}
	decode(t, call("POST", "/api/uploads/"+upload.ID+"/parts", map[string]any{"numbers": []int{1}}, 200), &urls)
	req, _ := http.NewRequest("PUT", urls[0].URL, bytes.NewReader(nil))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	type result struct {
		status int
		data   []byte
	}
	results := make(chan result, 2)
	for i := 0; i < 2; i++ {
		go func() {
			status, data := b.do("POST", "/api/uploads/"+upload.ID+"/complete", nil)
			results <- result{status, data}
		}()
	}
	first, second := <-results, <-results
	if first.status != 200 || second.status != 200 || !bytes.Equal(first.data, second.data) {
		t.Fatalf("concurrent finish: %+v %+v", first, second)
	}
	events := 0
	for _, event := range readAuditEvents(t, stores.config.DatabaseURL) {
		if event.Action == "upload" {
			events++
		}
	}
	if events != 1 {
		t.Fatalf("events %d", events)
	}
}

func TestUploadOwnershipAuthorizationAndPolicyConfiguration(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	admin := newBrowser(t, server)
	signInAsAdministrator(t, admin)
	call := func(b *browser, method, path string, body any, want int) []byte {
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
	var userID int64
	err = conn.QueryRow(context.Background(), `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT 'uploader','Uploader',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`).Scan(&userID)
	if err != nil {
		t.Fatal(err)
	}
	reader := newBrowser(t, server)
	if status, _ := reader.signIn("uploader", initialAdministratorPassword); status != 200 {
		t.Fatal(status)
	}
	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/api/tree", map[string]any{"name": "Restricted"}, 201), &dir)
	body := map[string]any{"parentId": dir.ID, "name": "owned.txt", "size": 3}
	call(reader, "POST", "/api/uploads", body, 404)
	call(admin, "POST", fmt.Sprintf("/api/tree/%d/grants", dir.ID), map[string]any{"principalKind": "user", "principalId": userID, "rights": 1, "scope": "subtree"}, 201)
	call(reader, "POST", "/api/uploads", body, 403)
	var grant struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", fmt.Sprintf("/api/tree/%d/grants", dir.ID), map[string]any{"principalKind": "user", "principalId": userID, "rights": 4, "scope": "subtree"}, 201), &grant)
	var upload struct {
		ID string `json:"id"`
	}
	decode(t, call(reader, "POST", "/api/uploads", body, 201), &upload)
	call(admin, "POST", "/api/uploads/"+upload.ID+"/parts", map[string]any{"numbers": []int{1}}, 404)
	call(admin, "POST", "/api/uploads/"+upload.ID+"/complete", nil, 404)
	call(reader, "PUT", "/api/upload-policy", map[string]any{"blockedExtensions": []string{"txt"}}, 403)
	call(admin, "PUT", "/api/upload-policy", map[string]any{"blockedExtensions": []string{".TXT"}}, 200)
	call(admin, "POST", "/api/uploads", body, 400)
	call(admin, "DELETE", fmt.Sprintf("/api/tree/%d/grants/%d", dir.ID, grant.ID), nil, 204)
	call(reader, "POST", "/api/uploads/"+upload.ID+"/complete", nil, 403)
	call(reader, "POST", "/api/uploads/"+upload.ID+"/parts", map[string]any{"numbers": []int{1}}, 403)
}

func TestFolderBatchRemainsHiddenUntilEveryChildCompletes(t *testing.T) {
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
	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call("POST", "/api/tree", map[string]any{"name": "Batch destination"}, 201), &dir)
	var sessions []struct {
		ID string `json:"id"`
	}
	decode(t, call("POST", "/api/upload-batches", map[string]any{"parentId": dir.ID, "name": "Folder", "files": []any{map[string]any{"path": "a.txt", "size": 3}, map[string]any{"path": "nested/b.txt", "size": 3}}}, 201), &sessions)
	listing := fmt.Sprintf("/api/tree?parentId=%d", dir.ID)
	for i, session := range sessions {
		if data := call("GET", listing, nil, 200); strings.Contains(string(data), "Folder") {
			t.Fatal("incomplete folder visible")
		}
		var urls []struct {
			URL string `json:"url"`
		}
		decode(t, call("POST", "/api/uploads/"+session.ID+"/parts", map[string]any{"numbers": []int{1}}, 200), &urls)
		req, _ := http.NewRequest("PUT", urls[0].URL, strings.NewReader("abc"))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatal(res.StatusCode)
		}
		call("POST", "/api/uploads/"+session.ID+"/complete", nil, 200)
		if i == len(sessions)-1 {
			if data := call("GET", listing, nil, 200); !strings.Contains(string(data), "Folder") {
				t.Fatal("complete folder missing")
			}
		}
	}
}
