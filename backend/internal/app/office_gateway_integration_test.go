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

func TestOfficeGatewayDelivery(t *testing.T) {
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
	content := bytes.Repeat([]byte("exact Office bytes\x00\xff"), 1024*1024)
	client, err := minio.New(stores.config.MinIOEndpoint, &minio.Options{Creds: credentials.NewStaticV4(stores.config.MinIOAccessKey, stores.config.MinIOSecretKey, "")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.PutObject(context.Background(), stores.config.MinIOBucket, "gateway-document", bytes.NewReader(content), int64(len(content)), minio.PutObjectOptions{}); err != nil {
		t.Fatal(err)
	}
	var file int64
	if err = conn.QueryRow(context.Background(), "INSERT INTO tree_nodes(name,is_file) VALUES('report.docx',true) RETURNING id").Scan(&file); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(context.Background(), "INSERT INTO file_versions(file_id,object_key,size,format,created_by,created_at) SELECT $1,'gateway-document',$2,'docx',id,$3 FROM users WHERE is_administrator LIMIT 1", file, len(content), fake.Now()); err != nil {
		t.Fatal(err)
	}
	type permit struct {
		Document string `json:"documentUrl"`
		Delivery string `json:"deliveryCheckUrl"`
	}
	start := func() permit {
		t.Helper()
		status, body := owner.do("POST", fmt.Sprintf("/api/files/%d/office-edits", file), map[string]any{})
		if status != 201 {
			t.Fatalf("start: %d %s", status, body)
		}
		var p permit
		decode(t, body, &p)
		return p
	}
	get := func(path string) (int, []byte) {
		t.Helper()
		res, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		if res.Request.URL.Path != path {
			t.Fatal("redirect")
		}
		return res.StatusCode, body
	}
	check := func(p permit, want bool) {
		t.Helper()
		status, body := owner.do("GET", p.Delivery, nil)
		if status != 200 {
			t.Fatalf("check: %d %s", status, body)
		}
		var result struct {
			Delivered bool `json:"delivered"`
		}
		decode(t, body, &result)
		if result.Delivered != want {
			t.Fatalf("delivery: %s", body)
		}
	}
	p := start()
	check(p, false)
	if status, body := get(p.Document); status != 200 || !bytes.Equal(body, content) {
		t.Fatalf("document: %d %q", status, body)
	}
	check(p, true)
	if status, body := get(p.Document); status < 400 || bytes.Equal(body, content) {
		t.Fatalf("reuse: %d %q", status, body)
	}
	interrupted := start()
	response, err := http.Get(server.URL + interrupted.Document)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 {
		t.Fatal(response.StatusCode)
	}
	var prefix [1]byte
	if _, err = response.Body.Read(prefix[:]); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	check(interrupted, false)
	// A failed transfer did not consume the capability.
	if status, body := get(interrupted.Document); status != 200 || !bytes.Equal(body, content) {
		t.Fatalf("retry: %d", status)
	}
	check(interrupted, true)
	parallel := start()
	statuses := make(chan int, 2)
	for range 2 {
		go func() {
			res, err := http.Get(server.URL + parallel.Document)
			if err != nil {
				statuses <- 0
				return
			}
			_, err = io.Copy(io.Discard, res.Body)
			res.Body.Close()
			if err != nil {
				statuses <- 0
				return
			}
			statuses <- res.StatusCode
		}()
	}
	first, second := <-statuses, <-statuses
	if !((first == 200 && second == 410) || (first == 410 && second == 200)) {
		t.Fatalf("parallel reads: %d %d", first, second)
	}
	p = start()
	fake.Advance(5 * time.Minute)
	if status, body := get(p.Document); status < 400 || bytes.Equal(body, content) {
		t.Fatalf("expiry: %d %q", status, body)
	}
	check(p, false)
	if status, _ := get("/api/office/permits/invalid/document/report.docx"); status < 400 {
		t.Fatal(status)
	}
	if status, _ := get("/api/office/permits/document/report.docx"); status < 400 {
		t.Fatal(status)
	}
	opens := 0
	for _, event := range readAuditEvents(t, stores.config.DatabaseURL) {
		if event.Action == "open_for_edit" {
			opens++
		}
	}
	if opens != 4 {
		t.Fatalf("open-for-edit audit count: %d", opens)
	}
	anonymous := newBrowser(t, server)
	if status, _ := anonymous.do("GET", p.Delivery, nil); status != 401 {
		t.Fatal(status)
	}
	if _, err = conn.Exec(context.Background(), `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT 'gateway-other','Other',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1`); err != nil {
		t.Fatal(err)
	}
	other := newBrowser(t, server)
	if status, _ := other.signIn("gateway-other", initialAdministratorPassword); status != 200 {
		t.Fatal(status)
	}
	if status, _ := other.do("GET", p.Delivery, nil); status != 404 {
		t.Fatal(status)
	}
}
