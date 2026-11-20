//go:build integration

package app_test

import (
	"bytes"
	"context"
	"crypto/md5"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/liumingjian/ftp-master/backend/internal/scheduler"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"io"
	"mime/multipart"
	"net/http"
	"sync"
	"testing"
	"time"
)

func TestSchedulerClockAndConcurrentPurge(t *testing.T) {
	stores := startStores(t)
	clk := clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC))
	server := startService(t, stores.config, clk)
	b := newBrowser(t, server)
	signInAsAdministrator(t, b)
	status, data := b.do("POST", "/api/tree", map[string]any{"name": "Expired"})
	if status != 201 {
		t.Fatalf("create: %d %s", status, data)
	}
	var node struct {
		ID int64 `json:"id"`
	}
	decode(t, data, &node)
	status, data = b.do("DELETE", fmt.Sprintf("/api/tree/%d", node.ID), nil)
	if status != 204 {
		t.Fatalf("delete: %d %s", status, data)
	}
	pool, err := pgxpool.New(context.Background(), stores.config.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	job := scheduler.New(pool, nil, "", clk)
	if err = job.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	status, data = b.do("GET", "/api/recycle-bin", nil)
	if status != 200 || !bytes.Contains(data, []byte("Expired")) {
		t.Fatalf("early purge: %s", data)
	}
	clk.Advance(30 * 24 * time.Hour)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := job.Run(context.Background()); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	signInAsAdministrator(t, b)
	status, data = b.do("GET", "/api/recycle-bin", nil)
	if status != 200 || bytes.Contains(data, []byte("Expired")) {
		t.Fatalf("not purged: %s", data)
	}
	var count int
	if err = pool.QueryRow(context.Background(), "SELECT count(*) FROM audit_events WHERE action='automatic_purge'").Scan(&count); err != nil || count != 1 {
		t.Fatalf("audit %d %v", count, err)
	}
}

// Fixture writes create historical versions and unfinished transfers cheaply;
// Run, HTTP history, audit records and real object reads are the observed seams.
func TestSchedulerVersionsMultipartAndAuditRetention(t *testing.T) {
	stores := startStores(t)
	ctx := context.Background()
	clk := clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC))
	server := startService(t, stores.config, clk)
	b := newBrowser(t, server)
	signInAsAdministrator(t, b)
	pool, err := pgxpool.New(ctx, stores.config.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	client, err := minio.New(stores.config.MinIOEndpoint, &minio.Options{Creds: credentials.NewStaticV4(stores.config.MinIOAccessKey, stores.config.MinIOSecretKey, "")})
	if err != nil {
		t.Fatal(err)
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	var uid, file, parent int64
	if err = pool.QueryRow(ctx, "SELECT id FROM users WHERE username='admin'").Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, "INSERT INTO tree_nodes(name) VALUES('Scheduler fixtures') RETURNING id").Scan(&parent); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, "INSERT INTO tree_nodes(name,parent_id,is_file) VALUES('versions.txt',$1,true) RETURNING id", parent).Scan(&file); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 23; i++ {
		key := fmt.Sprintf("retention-%d", i)
		if i == 23 {
			key = "retention-1"
		}
		if _, err = client.PutObject(ctx, stores.config.MinIOBucket, key, bytes.NewReader([]byte("x")), 1, minio.PutObjectOptions{}); err != nil {
			t.Fatal(err)
		}
		exec("INSERT INTO file_versions(file_id,object_key,size,created_by,created_at) VALUES($1,$2,1,$3,$4)", file, key, uid, clk.Now())
	}
	// Historical completed receipts must not prevent pruning their version FK.
	var firstVersion int64
	if err = pool.QueryRow(ctx, "SELECT min(id) FROM file_versions WHERE file_id=$1", file).Scan(&firstVersion); err != nil {
		t.Fatal(err)
	}
	exec("INSERT INTO upload_sessions(id,owner_id,parent_id,name,size,object_key,storage_upload_id,part_size,part_count,state,file_id,version_id,created_at) VALUES('receipt',$1,$2,'versions.txt',1,'retention-2','done',1,1,'complete',$3,$4,$5)", uid, parent, file, firstVersion, clk.Now())
	// Historical permit base IDs survive version pruning independently.
	exec("INSERT INTO office_edit_permits(id,user_id,file_id,version_id,created_at,expires_at) VALUES('pin',$1,$2,$3,$4,$5)", uid, file, firstVersion, clk.Now(), clk.Now().Add(time.Hour))
	core := minio.Core{Client: client}
	uploadID, err := core.NewMultipartUpload(ctx, stores.config.MinIOBucket, "abandoned", minio.PutObjectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	exec("INSERT INTO upload_sessions(id,owner_id,parent_id,name,size,object_key,storage_upload_id,part_size,part_count,created_at) VALUES('abandoned',$1,$2,'pending.txt',1,'abandoned',$3,1,1,$4)", uid, parent, uploadID, clk.Now())
	// A hidden reservation with no child upload must also eventually disappear.
	var hidden int64
	if err = pool.QueryRow(ctx, "INSERT INTO tree_nodes(name,parent_id) VALUES('Hidden',$1) RETURNING id", parent).Scan(&hidden); err != nil {
		t.Fatal(err)
	}
	exec("INSERT INTO upload_batches(id,owner_id,parent_id,root_id,expected,created_at) VALUES('hidden',$1,$2,$3,1,$4)", uid, parent, hidden, clk.Now())
	exec("INSERT INTO upload_batch_nodes VALUES($1,'hidden')", hidden)
	// Seed a retired month and the month spanning the 180 day cutoff.
	old := clk.Now().Add(-250 * 24 * time.Hour)
	young := clk.Now().Add(-179 * 24 * time.Hour)
	for _, at := range []time.Time{old, young} {
		exec("SELECT audit_ensure_partition($1)", at)
		exec("INSERT INTO audit_events(occurred_at,username,action,outcome) VALUES($1,'fixture','retention_fixture','success')", at)
	}
	job := scheduler.New(pool, client, stores.config.MinIOBucket, clk)
	run := func() {
		t.Helper()
		var wg sync.WaitGroup
		for i := 0; i < 4; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if err := job.Run(ctx); err != nil {
					t.Error(err)
				}
			}()
		}
		wg.Wait()
	}
	run()
	var count int
	check := func(sql string, want int, args ...any) {
		t.Helper()
		if err := pool.QueryRow(ctx, sql, args...).Scan(&count); err != nil || count != want {
			t.Fatalf("%s: got %d want %d err %v", sql, count, want, err)
		}
	}
	check("SELECT count(*) FROM file_versions WHERE file_id=$1", 20, file)
	check("SELECT count(*) FROM upload_sessions WHERE id='abandoned'", 1)
	check("SELECT count(*) FROM audit_events WHERE action='retention_fixture'", 1)
	exec("UPDATE office_edit_permits SET delivered_at=$1 WHERE id='pin'", clk.Now())
	clk.Advance(24 * time.Hour)
	run()
	check("SELECT count(*) FROM file_versions WHERE file_id=$1", 20, file)
	// Delivered edits remain valid beyond the delivery deadline; releasing the
	// fixture permit models an editor session explicitly retired by its owner.
	exec("DELETE FROM office_edit_permits WHERE id='pin'")
	run()
	check("SELECT count(*) FROM file_versions WHERE file_id=$1", 20, file)
	check("SELECT count(*) FROM upload_sessions WHERE id='abandoned'", 0)
	check("SELECT count(*) FROM tree_nodes WHERE id=$1", 0, hidden)
	if _, err = core.ListObjectParts(ctx, stores.config.MinIOBucket, "abandoned", uploadID, 0, 100); minio.ToErrorResponse(err).Code != "NoSuchUpload" {
		t.Fatalf("multipart not aborted: %v", err)
	}
	if _, err = client.StatObject(ctx, stores.config.MinIOBucket, "retention-3", minio.StatObjectOptions{}); minio.ToErrorResponse(err).Code != "NoSuchKey" {
		t.Fatalf("pruned bytes remain: %v", err)
	}
	if _, err = client.StatObject(ctx, stores.config.MinIOBucket, "retention-1", minio.StatObjectOptions{}); err != nil {
		t.Fatalf("shared restored bytes removed: %v", err)
	}
	// Completed receipts preserve IDs but do not indefinitely pin pruned bytes.
	if _, err = client.StatObject(ctx, stores.config.MinIOBucket, "retention-2", minio.StatObjectOptions{}); minio.ToErrorResponse(err).Code != "NoSuchKey" {
		t.Fatalf("pruned receipt bytes remain: %v", err)
	}
	if _, err = pool.Exec(ctx, "DELETE FROM audit_events"); err == nil {
		t.Fatal("application gained audit delete permission")
	}
}

func TestSchedulerPrunedOfficeBaseStillDeliversAndSaves(t *testing.T) {
	stores := startStores(t)
	ctx := context.Background()
	clk := clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC))
	server := startService(t, stores.config, clk)
	b := newBrowser(t, server)
	signInAsAdministrator(t, b)
	pool, err := pgxpool.New(ctx, stores.config.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	client, err := minio.New(stores.config.MinIOEndpoint, &minio.Options{Creds: credentials.NewStaticV4(stores.config.MinIOAccessKey, stores.config.MinIOSecretKey, "")})
	if err != nil {
		t.Fatal(err)
	}
	content := officeZip(t, false)
	if _, err = client.PutObject(ctx, stores.config.MinIOBucket, "office-base", bytes.NewReader(content), int64(len(content)), minio.PutObjectOptions{}); err != nil {
		t.Fatal(err)
	}
	var file int64
	if err = pool.QueryRow(ctx, "INSERT INTO tree_nodes(name,is_file) VALUES('retained.docx',true) RETURNING id").Scan(&file); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, "INSERT INTO file_versions(file_id,object_key,size,format,created_by,created_at) SELECT $1,'office-base',$2,'docx',id,$3 FROM users WHERE username='admin'", file, len(content), clk.Now()); err != nil {
		t.Fatal(err)
	}
	status, data := b.do("POST", fmt.Sprintf("/api/files/%d/office-edits", file), map[string]any{})
	if status != 201 {
		t.Fatalf("edit %d %s", status, data)
	}
	var permit struct {
		Document string `json:"documentUrl"`
		Save     string `json:"saveUrl"`
	}
	decode(t, data, &permit)
	if _, err = pool.Exec(ctx, "INSERT INTO file_versions(file_id,object_key,size,format,created_by,created_at) SELECT $1,'new-base',0,'docx',u.id,$2 FROM users u CROSS JOIN generate_series(1,20) WHERE username='admin'", file, clk.Now()); err != nil {
		t.Fatal(err)
	}
	jobs := scheduler.New(pool, client, stores.config.MinIOBucket, clk)
	if err = jobs.Run(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM file_versions WHERE file_id=$1", file).Scan(&count); err != nil || count != 20 {
		t.Fatalf("retention %d %v", count, err)
	}
	res, err := http.Get(server.URL + permit.Document)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !bytes.Equal(body, content) {
		t.Fatalf("pruned pending delivery %d %s", res.StatusCode, body)
	}
	clk.Advance(10 * time.Minute)
	if err = jobs.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = client.StatObject(ctx, stores.config.MinIOBucket, "office-base", minio.StatObjectOptions{}); minio.ToErrorResponse(err).Code != "NoSuchKey" {
		t.Fatalf("delivered base not collected: %v", err)
	}
	var payload bytes.Buffer
	writer := multipart.NewWriter(&payload)
	part, _ := writer.CreateFormFile("filedata", "retained.docx")
	part.Write(content)
	writer.WriteField("md5sum", fmt.Sprintf("%x", md5.Sum(content)))
	writer.WriteField("filename", "retained.docx")
	writer.Close()
	req, _ := http.NewRequest("POST", server.URL+permit.Save, &payload)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.AddCookie(b.cookie)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("save after prune %d %s", res.StatusCode, body)
	}
}
