//go:build integration

package app_test

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/md5"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"testing"
	"time"
)

func TestOfficeSaveMalformedReceipt(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	req, _ := http.NewRequest("POST", server.URL+"/api/office/permits/invalid/save", bytes.NewBufferString("broken"))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=x")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	var receipt map[string]any
	decode(t, body, &receipt)
	if res.StatusCode < 400 || receipt["Success"] != false {
		t.Fatalf("receipt: %d %s", res.StatusCode, body)
	}
	if _, ok := receipt["Data"]; !ok {
		t.Fatalf("missing Data: %s", body)
	}
}

func officeZip(t *testing.T, spreadsheet bool) []byte {
	t.Helper()
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	parts := map[string]string{"[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`, "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`}
	if spreadsheet {
		delete(parts, "word/document.xml")
		parts["[Content_Types].xml"] = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`
		parts["xl/workbook.xml"] = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>`
	}
	for name, value := range parts {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(f, value)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func TestOfficeSaveVersions(t *testing.T) {
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
	for _, sheet := range []bool{false, true} {
		content := officeZip(t, sheet)
		format := "docx"
		if sheet {
			format = "xlsx"
		}
		key := "save-original-" + format
		_, err = client.PutObject(context.Background(), stores.config.MinIOBucket, key, bytes.NewReader(content), int64(len(content)), minio.PutObjectOptions{})
		if err != nil {
			t.Fatal(err)
		}
		var file int64
		err = conn.QueryRow(context.Background(), "INSERT INTO tree_nodes(name,is_file) VALUES($1,true) RETURNING id", "report."+format).Scan(&file)
		if err != nil {
			t.Fatal(err)
		}
		_, err = conn.Exec(context.Background(), "INSERT INTO file_versions(file_id,object_key,size,format,created_by,created_at) SELECT $1,$2,$3,$4,id,$5 FROM users WHERE is_administrator LIMIT 1", file, key, len(content), format, fake.Now())
		if err != nil {
			t.Fatal(err)
		}
		status, body := owner.do("POST", fmt.Sprintf("/api/files/%d/office-edits", file), map[string]any{})
		if status != 201 {
			t.Fatalf("start %d %s", status, body)
		}
		var permit struct {
			Document string `json:"documentUrl"`
			Save     string `json:"saveUrl"`
		}
		decode(t, body, &permit)
		sender := owner
		post := func(mode string, data []byte, checksum string, want int) {
			t.Helper()
			var b bytes.Buffer
			w := multipart.NewWriter(&b)
			if mode == "writer" {
				part, _ := w.CreateFormFile("filedata", "report.docx")
				_, _ = part.Write(data)
				_ = w.WriteField("md5sum", checksum)
				_ = w.WriteField("filename", "report.docx")
			} else if mode == "et-part" {
				part, _ := w.CreatePart(textproto.MIMEHeader{"Content-Disposition": {`form-data; name="file"; filename=""`}, "Content-Type": {"application/octet-stream"}})
				_, _ = part.Write(data)
			} else {
				_ = w.WriteField("file", string(data))
			}
			_ = w.Close()
			req, _ := http.NewRequest("POST", server.URL+permit.Save, &b)
			req.Header.Set("Content-Type", w.FormDataContentType())
			if sender.cookie != nil {
				req.AddCookie(sender.cookie)
			}
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			body, _ := io.ReadAll(res.Body)
			var receipt map[string]any
			decode(t, body, &receipt)
			if res.StatusCode != want || receipt["Success"] != (want == 200) {
				t.Fatalf("save %s: %d %s", mode, res.StatusCode, body)
			}
		}
		mode := "writer"
		if sheet {
			mode = "et-part"
		}
		sum := fmt.Sprintf("%x", md5.Sum(content))
		post(mode, content, sum, 409)
		res, err := http.Get(server.URL + permit.Document)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
		post(mode, content, sum, 200)
		if sheet {
			mode = "et-value"
		}
		post(mode, content, sum, 200)
		if !sheet {
			post(mode, content, "00000000000000000000000000000000", 400)
		}
		post(mode, []byte("malformed"), fmt.Sprintf("%x", md5.Sum([]byte("malformed"))), 415)
		cross := officeZip(t, !sheet)
		post(mode, cross, fmt.Sprintf("%x", md5.Sum(cross)), 415)
		legacyFormat := "doc"
		if sheet {
			legacyFormat = "xls"
		}
		legacy, err := os.ReadFile("testdata/office/legacy." + legacyFormat)
		if err != nil {
			t.Fatal(err)
		}
		post(mode, legacy, fmt.Sprintf("%x", md5.Sum(legacy)), 200)
		sender = newBrowser(t, server)
		post(mode, content, sum, 401)
		_, err = conn.Exec(context.Background(), `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT $1,'Other',password_hash,true,'active',created_at FROM users WHERE username='admin' LIMIT 1`, "save-other-"+format)
		if err != nil {
			t.Fatal(err)
		}
		if status, _ := sender.signIn("save-other-"+format, initialAdministratorPassword); status != 200 {
			t.Fatal(status)
		}
		post(mode, content, sum, 404)
		sender = owner
		_, err = conn.Exec(context.Background(), "UPDATE users SET is_administrator=false WHERE username='admin'")
		if err != nil {
			t.Fatal(err)
		}
		post(mode, content, sum, 404)
		_, err = conn.Exec(context.Background(), "UPDATE users SET is_administrator=true WHERE username='admin'")
		if err != nil {
			t.Fatal(err)
		}
		_, err = conn.Exec(context.Background(), `CREATE FUNCTION reject_office_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='office_save' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_office_save BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_office_save()`)
		if err != nil {
			t.Fatal(err)
		}
		post(mode, content, sum, 500)
		_, err = conn.Exec(context.Background(), "DROP TRIGGER reject_office_save ON audit_events; DROP FUNCTION reject_office_save()")
		if err != nil {
			t.Fatal(err)
		}
		var actual string
		if err = conn.QueryRow(context.Background(), "SELECT format FROM file_versions WHERE file_id=$1 ORDER BY id DESC LIMIT 1", file).Scan(&actual); err != nil || actual != legacyFormat {
			t.Fatalf("actual format %s: %v", actual, err)
		}
		var versions int
		err = conn.QueryRow(context.Background(), "SELECT count(*) FROM file_versions WHERE file_id=$1", file).Scan(&versions)
		if err != nil || versions != 4 {
			t.Fatalf("versions %d %v", versions, err)
		}
		original, err := client.GetObject(context.Background(), stores.config.MinIOBucket, key, minio.GetObjectOptions{})
		if err != nil {
			t.Fatal(err)
		}
		got, _ := io.ReadAll(original)
		original.Close()
		if !bytes.Equal(got, content) {
			t.Fatal("immutable original changed")
		}
	}
	var saves, stale int
	err = conn.QueryRow(context.Background(), "SELECT count(*),count(*) FILTER (WHERE detail->>'staleSave'='true') FROM audit_events WHERE action='office_save'").Scan(&saves, &stale)
	if err != nil || saves != 6 || stale != 4 {
		t.Fatalf("audit saves=%d stale=%d: %v", saves, stale, err)
	}
}
