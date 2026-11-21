//go:build integration

package app_test

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/liumingjian/ftp-master/backend/internal/clock"
	"testing"
	"time"
)

func TestSharedTreeCreatesAndListsStableDirectories(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	b := newBrowser(t, server)
	signInAsAdministrator(t, b)
	status, data := b.do("POST", "/api/tree", map[string]any{"name": "Projects"})
	if status != 201 {
		t.Fatalf("create: %d %s", status, data)
	}
	var node struct {
		ID int64 `json:"id"`
	}
	decode(t, data, &node)
	if node.ID <= 0 {
		t.Fatal("missing stable id")
	}
	status, data = b.do("GET", "/api/tree", nil)
	if status != 200 {
		t.Fatalf("list: %d %s", status, data)
	}
	var nodes []struct {
		ID int64 `json:"id"`
	}
	decode(t, data, &nodes)
	if len(nodes) != 1 || nodes[0].ID != node.ID {
		t.Fatalf("unexpected listing %s", data)
	}
}

func TestSharedTreeFiltersTraversalAndDropBoxAndAuditsGrants(t *testing.T) {
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
	err = conn.QueryRow(ctx, `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT 'reader','Reader',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`).Scan(&userID)
	if err != nil {
		t.Fatal(err)
	}
	reader := newBrowser(t, server)
	if status, _ := reader.signIn("reader", initialAdministratorPassword); status != 200 {
		t.Fatal(status)
	}
	call := func(b *browser, method, path string, body any, want int) []byte {
		t.Helper()
		status, data := b.do(method, "/api"+path, body)
		if status != want {
			t.Fatalf("%s %s: %d want %d: %s", method, path, status, want, data)
		}
		return data
	}
	create := func(name string, parent int64) int64 {
		t.Helper()
		body := map[string]any{"name": name}
		if parent != 0 {
			body["parentId"] = parent
		}
		var n struct {
			ID int64 `json:"id"`
		}
		decode(t, call(admin, "POST", "/tree", body, 201), &n)
		return n.ID
	}
	root := create("Root", 0)
	deep := create("Deep", root)
	hidden := create("Secret", root)
	box := create("Drop Box", root)
	private := create("Private contents", box)
	call(reader, "POST", "/tree", map[string]any{"name": "denied"}, 403)
	call(reader, "GET", fmt.Sprintf("/tree/%d", deep), nil, 404)
	grant := func(id int64, kind string, principal int64, rights int) {
		call(admin, "POST", fmt.Sprintf("/tree/%d/grants", id), map[string]any{"principalKind": kind, "principalId": principal, "rights": rights, "scope": "subtree"}, 201)
	}
	grant(deep, "user", userID, 1)
	grant(box, "user", userID, 4)
	var list []struct {
		ID int64 `json:"id"`
	}
	decode(t, call(reader, "GET", "/tree", nil, 200), &list)
	if len(list) != 1 || list[0].ID != root {
		t.Fatalf("root listing %v", list)
	}
	decode(t, call(reader, "GET", fmt.Sprintf("/tree?parentId=%d", root), nil, 200), &list)
	if len(list) != 2 {
		t.Fatalf("traversal listing %v", list)
	}
	for _, n := range list {
		if n.ID == hidden {
			t.Fatal("sibling leaked")
		}
	}
	decode(t, call(reader, "GET", fmt.Sprintf("/tree?parentId=%d", box), nil, 200), &list)
	if len(list) != 0 {
		t.Fatal("Drop Box leaked contents")
	}
	call(reader, "GET", fmt.Sprintf("/tree/%d", private), nil, 404)
	call(reader, "POST", "/tree", map[string]any{"name": "Allowed submission directory", "parentId": box}, 201)
	call(reader, "POST", "/tree", map[string]any{"name": "denied", "parentId": deep}, 403)
	call(reader, "POST", "/tree", map[string]any{"name": "denied", "parentId": hidden}, 404)
	before := len(readAuditEvents(t, stores.config.DatabaseURL))
	call(reader, "GET", "/tree", nil, 200)
	if len(readAuditEvents(t, stores.config.DatabaseURL)) != before {
		t.Fatal("browsing audited")
	}
	events := readAuditEvents(t, stores.config.DatabaseURL)
	count := 0
	for _, e := range events {
		if e.Action == "grant_change" {
			count++
		}
	}
	if count != 2 {
		t.Fatalf("Grant events: %d", count)
	}
	var group struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/user-groups", map[string]any{"name": "Readers"}, 201), &group)
	call(admin, "PUT", fmt.Sprintf("/user-groups/%d/members", group.ID), map[string]any{"userIds": []int64{userID}}, 204)
	grant(deep, "user_group", group.ID, 4)
	var node struct {
		Rights int `json:"rights"`
	}
	decode(t, call(reader, "GET", fmt.Sprintf("/tree/%d", deep), nil, 200), &node)
	if node.Rights != 5 {
		t.Fatalf("union: %d", node.Rights)
	}
	var org struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/organizations", map[string]any{"name": "Child", "parentId": 1}, 201), &org)
	_, err = conn.Exec(ctx, "UPDATE users SET organization_id=$1 WHERE id=$2", org.ID, userID)
	if err != nil {
		t.Fatal(err)
	}
	grant(hidden, "organization", 1, 1)
	call(reader, "GET", fmt.Sprintf("/tree/%d", hidden), nil, 200)
}

func TestSharedTreeRenameMovePreservesIdentityAndRefusesCycles(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	b := newBrowser(t, server)
	signInAsAdministrator(t, b)
	call := func(method, path string, body any, want int) []byte {
		t.Helper()
		status, data := b.do(method, "/api"+path, body)
		if status != want {
			t.Fatalf("%s %s: %d want %d %s", method, path, status, want, data)
		}
		return data
	}
	create := func(name string, parent int64) int64 {
		body := map[string]any{"name": name}
		if parent != 0 {
			body["parentId"] = parent
		}
		var n struct {
			ID int64 `json:"id"`
		}
		decode(t, call("POST", "/tree", body, 201), &n)
		return n.ID
	}
	root := create("Source", 0)
	target := create("Target", 0)
	child := create("Original", root)
	deep := create("Deep", child)
	call("POST", fmt.Sprintf("/tree/%d/rename", child), map[string]any{"name": "Renamed"}, 200)
	call("POST", fmt.Sprintf("/tree/%d/move", child), map[string]any{"parentId": deep}, 409)
	call("POST", fmt.Sprintf("/tree/%d/move", child), map[string]any{"parentId": target}, 200)
	var n struct {
		ID       int64  `json:"id"`
		ParentID int64  `json:"parentId"`
		Name     string `json:"name"`
	}
	decode(t, call("GET", fmt.Sprintf("/tree/%d", child), nil, 200), &n)
	if n.ID != child || n.ParentID != target || n.Name != "Renamed" {
		t.Fatalf("unexpected moved item %+v", n)
	}
	create("Conflict", target)
	call("POST", fmt.Sprintf("/tree/%d/rename", child), map[string]any{"name": "Conflict"}, 409)
	for _, name := range []string{"..", "a/b", "a\\b", " ", "bad\x00name"} {
		call("POST", fmt.Sprintf("/tree/%d/rename", child), map[string]any{"name": name}, 400)
	}
	events := readAuditEvents(t, stores.config.DatabaseURL)
	rename, move := 0, 0
	for _, e := range events {
		if e.Action == "rename" {
			rename++
		}
		if e.Action == "move" {
			move++
		}
	}
	if rename != 1 || move != 1 {
		t.Fatalf("audit counts rename=%d move=%d", rename, move)
	}
}

func TestSharedTreeMoveReevaluatesInheritedRightsAndKeepsDirectGrants(t *testing.T) {
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
	var uid int64
	err = conn.QueryRow(ctx, `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT 'mover','Mover',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`).Scan(&uid)
	if err != nil {
		t.Fatal(err)
	}
	reader := newBrowser(t, server)
	if status, _ := reader.signIn("mover", initialAdministratorPassword); status != 200 {
		t.Fatal(status)
	}
	call := func(b *browser, method, path string, body any, want int) []byte {
		t.Helper()
		status, data := b.do(method, "/api"+path, body)
		if status != want {
			t.Fatalf("%s %s: %d want %d %s", method, path, status, want, data)
		}
		return data
	}
	create := func(name string, parent int64) int64 {
		body := map[string]any{"name": name}
		if parent != 0 {
			body["parentId"] = parent
		}
		var n struct {
			ID int64 `json:"id"`
		}
		decode(t, call(admin, "POST", "/tree", body, 201), &n)
		return n.ID
	}
	grant := func(id int64, rights int) {
		call(admin, "POST", fmt.Sprintf("/tree/%d/grants", id), map[string]any{"principalKind": "user", "principalId": uid, "rights": rights, "scope": "subtree"}, 201)
	}
	source := create("Source", 0)
	dest := create("Destination", 0)
	child := create("Child", source)
	path := fmt.Sprintf("/tree/%d", child)
	call(reader, "POST", path+"/rename", map[string]any{"name": "No"}, 404)
	grant(child, 1)
	call(reader, "POST", path+"/rename", map[string]any{"name": "No"}, 403)
	grant(source, 8)
	call(reader, "POST", path+"/rename", map[string]any{"name": "Renamed"}, 200)
	call(reader, "POST", path+"/move", map[string]any{"parentId": dest}, 403)
	grant(source, 16)
	call(reader, "POST", path+"/move", map[string]any{"parentId": dest}, 404)
	grant(dest, 1)
	call(reader, "POST", path+"/move", map[string]any{"parentId": dest}, 403)
	grant(dest, 4)
	call(reader, "POST", path+"/move", map[string]any{"parentId": dest}, 200)
	var n struct {
		Rights int `json:"rights"`
	}
	decode(t, call(reader, "GET", path, nil, 200), &n)
	if n.Rights != 5 {
		t.Fatalf("direct Browse plus destination Upload expected; got %d", n.Rights)
	}
	call(reader, "POST", path+"/rename", map[string]any{"name": "Lost Modify"}, 403)
	var oldPath, newPath string
	err = conn.QueryRow(ctx, `SELECT detail->>'oldPath',detail->>'newPath' FROM audit_events WHERE action='move' AND item_id=$1`, child).Scan(&oldPath, &newPath)
	if err != nil {
		t.Fatal(err)
	}
	if oldPath != "/Source/Renamed" || newPath != "/Destination/Renamed" {
		t.Fatalf("paths %q %q", oldPath, newPath)
	}
	// Deny audit writes to prove mutation and audit failure roll back together.
	if _, err = conn.Exec(ctx, "REVOKE INSERT ON audit_events FROM ftp_master_app"); err != nil {
		t.Fatal(err)
	}
	call(admin, "POST", path+"/rename", map[string]any{"name": "Must roll back"}, 500)
	var actual struct {
		Name string `json:"name"`
	}
	decode(t, call(admin, "GET", path, nil, 200), &actual)
	if actual.Name != "Renamed" {
		t.Fatalf("audit failure committed rename: %s", actual.Name)
	}
}

func TestGrantDraftAtomicSaveAndInheritedSources(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	b := newBrowser(t, server)
	signInAsAdministrator(t, b)
	status, data := b.do("POST", "/api/tree", map[string]any{"name": "Draft root"})
	if status != 201 {
		t.Fatal(status, string(data))
	}
	var n struct {
		ID int64 `json:"id"`
	}
	decode(t, data, &n)
	path := fmt.Sprintf("/api/tree/%d/grant-draft", n.ID)
	status, data = b.do("GET", path, nil)
	if status != 200 {
		t.Fatal(status, string(data))
	}
	status, data = b.do("POST", path+"/preview", map[string]any{"add": []any{map[string]any{"principalKind": "user", "principalId": 1, "rights": 1, "scope": "subtree"}}, "remove": []int64{}})
	if status != 200 {
		t.Fatal(status, string(data))
	}
	var impact struct {
		ChangedUsers int `json:"changedUsers"`
		CoveredItems int `json:"coveredItems"`
	}
	decode(t, data, &impact)
	if impact.ChangedUsers != 0 || impact.CoveredItems != 1 {
		t.Fatalf("administrator Rights do not change: %+v", impact)
	}
	// Invalid second principal must roll back the first creation and its audit.
	before := len(readAuditEvents(t, stores.config.DatabaseURL))
	status, data = b.do("POST", path, map[string]any{"add": []any{map[string]any{"principalKind": "user", "principalId": 1, "rights": 1, "scope": "subtree"}, map[string]any{"principalKind": "user", "principalId": 999999, "rights": 1, "scope": "subtree"}}, "remove": []int64{}})
	if status != 400 {
		t.Fatal(status, string(data))
	}
	status, data = b.do("GET", path, nil)
	var grants []any
	decode(t, data, &grants)
	if status != 200 || len(grants) != 0 {
		t.Fatal(status, string(data))
	}
	if len(readAuditEvents(t, stores.config.DatabaseURL)) != before {
		t.Fatal("failed draft audited")
	}
}

func TestGrantDraftDelegationAndScope(t *testing.T) {
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
	var uid int64
	err = conn.QueryRow(ctx, `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT 'delegate','Delegate',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`).Scan(&uid)
	if err != nil {
		t.Fatal(err)
	}
	delegated := newBrowser(t, server)
	if status, _ := delegated.signIn("delegate", initialAdministratorPassword); status != 200 {
		t.Fatal(status)
	}
	call := func(b *browser, method, path string, body any, want int) []byte {
		t.Helper()
		status, data := b.do(method, path, body)
		if status != want {
			t.Fatalf("%s %s: %d want %d %s", method, path, status, want, data)
		}
		return data
	}
	var root, child struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/api/tree", map[string]any{"name": "Area"}, 201), &root)
	decode(t, call(admin, "POST", "/api/tree", map[string]any{"name": "Child", "parentId": root.ID}, 201), &child)
	var unrelated struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/api/tree", map[string]any{"name": "Unrelated"}, 201), &unrelated)
	call(admin, "POST", fmt.Sprintf("/api/tree/%d/grants", unrelated.ID), map[string]any{"principalKind": "user", "principalId": 1, "rights": 1, "scope": "subtree"}, 201)
	grant := map[string]any{"principalKind": "user", "principalId": uid, "rights": 63, "scope": "this_level_only"}
	call(admin, "POST", fmt.Sprintf("/api/tree/%d/grants", root.ID), grant, 201)
	path := fmt.Sprintf("/api/tree/%d/grant-draft", root.ID)
	call(delegated, "GET", path, nil, 200)
	call(delegated, "GET", fmt.Sprintf("/api/tree/%d/grant-draft", child.ID), nil, 404)
	call(delegated, "GET", fmt.Sprintf("/api/tree/%d/permission?userId=1", root.ID), nil, 403)
	var inspection struct {
		Rights  int `json:"rights"`
		Sources []struct {
			Grant struct {
				ID int64 `json:"id"`
			} `json:"grant"`
		} `json:"sources"`
	}
	decode(t, call(admin, "GET", fmt.Sprintf("/api/tree/%d/permission?userId=%d", root.ID, uid), nil, 200), &inspection)
	if inspection.Rights != 63 || len(inspection.Sources) != 1 {
		t.Fatalf("inspection: %+v", inspection)
	}
	removal := map[string]any{"add": []any{}, "remove": []int64{inspection.Sources[0].Grant.ID}}
	var preview struct {
		ChangedUsers int      `json:"changedUsers"`
		CoveredItems int      `json:"coveredItems"`
		Warnings     []string `json:"warnings"`
	}
	decode(t, call(delegated, "POST", path+"/preview", removal, 200), &preview)
	if preview.ChangedUsers != 1 || preview.CoveredItems != 1 || len(preview.Warnings) != 1 || preview.Warnings[0] != "self_grant_loss" {
		t.Fatalf("preview: %+v", preview)
	}
	// Preview must not save the removal.
	call(delegated, "GET", path, nil, 200)
	grant["scope"] = "subtree"
	call(delegated, "POST", path, map[string]any{"add": []any{grant}, "remove": []int64{}}, 403)
	grant["scope"] = "this_level_only"
	grant["rights"] = 8
	call(delegated, "POST", path, map[string]any{"add": []any{grant}, "remove": []int64{}}, 204)
	var sources []struct {
		Grant struct {
			Rights int `json:"rights"`
		}
		Inherited  bool   `json:"inherited"`
		SourcePath string `json:"sourcePath"`
	}
	decode(t, call(admin, "GET", path, nil, 200), &sources)
	if len(sources) != 2 || sources[1].Grant.Rights != 11 {
		t.Fatalf("coherent saved Rights: %+v", sources)
	}
	grant["scope"] = "subtree"
	call(admin, "POST", fmt.Sprintf("/api/tree/%d/grants", root.ID), grant, 201)
	decode(t, call(admin, "GET", fmt.Sprintf("/api/tree/%d/grant-draft", child.ID), nil, 200), &sources)
	if len(sources) != 1 || !sources[0].Inherited || sources[0].SourcePath != "/Area" {
		t.Fatalf("inheritance: %+v", sources)
	}
	call(delegated, "POST", path, removal, 204)
	decode(t, call(admin, "GET", fmt.Sprintf("/api/tree/%d/permission?userId=%d", root.ID, uid), nil, 200), &inspection)
	if inspection.Rights != 11 {
		t.Fatalf("saved self-revocation: %+v", inspection)
	}
}

func TestGrantPreviewMatchesSavedEffectivePermission(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	b := newBrowser(t, server)
	signInAsAdministrator(t, b)
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stores.config.MigrationDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var uid int64
	err = conn.QueryRow(ctx, `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT 'impact','Impact',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`).Scan(&uid)
	if err != nil {
		t.Fatal(err)
	}
	status, data := b.do("POST", "/api/tree", map[string]any{"name": "Impact"})
	if status != 201 {
		t.Fatal(status, string(data))
	}
	var n struct {
		ID int64 `json:"id"`
	}
	decode(t, data, &n)
	path := fmt.Sprintf("/api/tree/%d", n.ID)
	draft := map[string]any{"add": []any{map[string]any{"principalKind": "user", "principalId": uid, "rights": 3, "scope": "subtree"}}, "remove": []int64{}}
	var before, after struct {
		Rights int `json:"rights"`
	}
	status, data = b.do("GET", fmt.Sprintf("%s/permission?userId=%d", path, uid), nil)
	if status != 200 {
		t.Fatal(status, string(data))
	}
	decode(t, data, &before)
	status, data = b.do("POST", path+"/grant-draft/preview", draft)
	if status != 200 {
		t.Fatal(status, string(data))
	}
	var impact struct {
		ChangedUsers int      `json:"changedUsers"`
		CoveredItems int      `json:"coveredItems"`
		Warnings     []string `json:"warnings"`
	}
	decode(t, data, &impact)
	if impact.ChangedUsers != 1 || impact.CoveredItems != 1 || len(impact.Warnings) != 0 {
		t.Fatalf("impact: %+v", impact)
	}
	status, data = b.do("POST", path+"/grant-draft", draft)
	if status != 204 {
		t.Fatal(status, string(data))
	}
	status, data = b.do("GET", fmt.Sprintf("%s/permission?userId=%d", path, uid), nil)
	if status != 200 {
		t.Fatal(status, string(data))
	}
	decode(t, data, &after)
	if before.Rights != 0 || after.Rights != 3 {
		t.Fatalf("saved Rights before=%d after=%d", before.Rights, after.Rights)
	}
	status, data = b.do("POST", path+"/grant-draft/preview", draft)
	if status != 200 {
		t.Fatal(status, string(data))
	}
	decode(t, data, &impact)
	if impact.ChangedUsers != 0 {
		t.Fatalf("redundant grant changes no Rights: %+v", impact)
	}
}

func TestGrantPreviewBroadWarningThresholds(t *testing.T) {
	stores := startStores(t)
	server := startService(t, stores.config, clock.NewFake(time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)))
	b := newBrowser(t, server)
	signInAsAdministrator(t, b)
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stores.config.MigrationDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var org int64
	if err = conn.QueryRow(ctx, `INSERT INTO organizations(name) VALUES ('Large') RETURNING id`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	_, err = conn.Exec(ctx, `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at,organization_id) SELECT 'large'||g,'Large',u.password_hash,false,'active',u.created_at,$1 FROM generate_series(1,50) g CROSS JOIN LATERAL (SELECT password_hash,created_at FROM users WHERE is_administrator LIMIT 1) u`, org)
	if err != nil {
		t.Fatal(err)
	}
	status, data := b.do("POST", "/api/tree", map[string]any{"name": "Broad"})
	if status != 201 {
		t.Fatal(status, string(data))
	}
	var n struct {
		ID int64 `json:"id"`
	}
	decode(t, data, &n)
	_, err = conn.Exec(ctx, `INSERT INTO tree_nodes(parent_id,name,is_file) SELECT $1,'Child'||g,false FROM generate_series(1,99) g`, n.ID)
	if err != nil {
		t.Fatal(err)
	}
	path := fmt.Sprintf("/api/tree/%d/grant-draft/preview", n.ID)
	check := func(scope string, want bool) {
		t.Helper()
		status, data := b.do("POST", path, map[string]any{"add": []any{map[string]any{"principalKind": "organization", "principalId": org, "rights": 1, "scope": scope}}, "remove": []int64{}})
		if status != 200 {
			t.Fatal(status, string(data))
		}
		var result struct {
			Warnings []string `json:"warnings"`
		}
		decode(t, data, &result)
		if (len(result.Warnings) > 0) != want {
			t.Fatalf("scope %s: %s", scope, data)
		}
	}
	check("subtree", true)
	check("this_level_only", false)
	if _, err = conn.Exec(ctx, `UPDATE users SET status='deactivated' WHERE username='large50'`); err != nil {
		t.Fatal(err)
	}
	check("subtree", false)
	if _, err = conn.Exec(ctx, `UPDATE users SET status='active' WHERE username='large50'`); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, `DELETE FROM tree_nodes WHERE parent_id=$1 AND name='Child99'`, n.ID); err != nil {
		t.Fatal(err)
	}
	check("subtree", false)
}
