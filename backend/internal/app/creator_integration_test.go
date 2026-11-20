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

func TestCreatorSharingAndDirectoryAdministration(t *testing.T) {
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
	ids := []int64{}
	for _, name := range []string{"creator", "inside", "outside", "manager"} {
		var id int64
		err = conn.QueryRow(ctx, `INSERT INTO users(username,display_name,password_hash,status,created_at) SELECT $1,$1,password_hash,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`, name).Scan(&id)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	creator := newBrowser(t, server)
	if status, _ := creator.signIn("creator", initialAdministratorPassword); status != 200 {
		t.Fatal(status)
	}
	manager := newBrowser(t, server)
	if status, _ := manager.signIn("manager", initialAdministratorPassword); status != 200 {
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
	var dir struct {
		ID int64 `json:"id"`
	}
	decode(t, call(admin, "POST", "/api/tree", map[string]any{"name": "Audience"}, 201), &dir)
	var file, grant int64
	err = conn.QueryRow(ctx, `INSERT INTO tree_nodes(parent_id,name,is_file) VALUES($1,'submission.txt',true) RETURNING id`, dir.ID).Scan(&file)
	if err != nil {
		t.Fatal(err)
	}
	err = conn.QueryRow(ctx, `INSERT INTO grants(node_id,principal_kind,principal_id,rights,scope,creator) VALUES($1,'user',$2,63,'subtree',true) RETURNING id`, file, ids[0]).Scan(&grant)
	if err != nil {
		t.Fatal(err)
	}
	input := func(id int64, rights int) map[string]any {
		return map[string]any{"principalKind": "user", "principalId": id, "rights": rights, "scope": "subtree"}
	}
	parent := fmt.Sprintf("/api/tree/%d/grants", dir.ID)
	path := fmt.Sprintf("/api/tree/%d", file)
	call(admin, "POST", parent, input(ids[1], 1), 201)
	before := len(readAuditEvents(t, stores.config.DatabaseURL))
	call(creator, "POST", path+"/grants", input(ids[2], 3), 403)
	if len(readAuditEvents(t, stores.config.DatabaseURL)) != before {
		t.Fatal("refused sharing audited")
	}
	call(creator, "POST", path+"/grants", input(ids[1], 3), 201)
	for _, suffix := range []string{"/grant-draft/preview", "/grant-draft"} {
		call(creator, "POST", path+suffix, map[string]any{"add": []any{input(ids[2], 1)}, "remove": []int64{}}, 403)
	}
	call(creator, "DELETE", fmt.Sprintf("%s/grants/%d", path, grant), nil, 403)
	call(creator, "POST", path+"/grant-draft", map[string]any{"add": []any{}, "remove": []int64{grant}}, 403)

	// Membership principals include every current member, including descendant Organizations.
	var org, childOrg, group int64
	if err = conn.QueryRow(ctx, `INSERT INTO organizations(name) VALUES('Audience organization') RETURNING id`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	if err = conn.QueryRow(ctx, `INSERT INTO organizations(name,parent_id) VALUES('Child organization',$1) RETURNING id`, org).Scan(&childOrg); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, `UPDATE users SET organization_id=$1 WHERE id IN ($2,$3)`, childOrg, ids[1], ids[2]); err != nil {
		t.Fatal(err)
	}
	if err = conn.QueryRow(ctx, `INSERT INTO user_groups(name) VALUES('Mixed audience') RETURNING id`).Scan(&group); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, `INSERT INTO user_group_members(group_id,user_id) VALUES($1,$2),($1,$3)`, group, ids[1], ids[2]); err != nil {
		t.Fatal(err)
	}
	for _, p := range []struct {
		kind string
		id   int64
	}{{"organization", org}, {"user_group", group}} {
		g := input(p.id, 3)
		g["principalKind"] = p.kind
		call(creator, "POST", path+"/grants", g, 403)
		for _, suffix := range []string{"/grant-draft/preview", "/grant-draft"} {
			call(creator, "POST", path+suffix, map[string]any{"add": []any{g}, "remove": []int64{}}, 403)
		}
	}
	call(admin, "POST", parent, input(ids[2], 1), 201)
	for _, p := range []struct {
		kind string
		id   int64
	}{{"organization", org}, {"user_group", group}} {
		g := input(p.id, 3)
		g["principalKind"] = p.kind
		call(creator, "POST", path+"/grants", g, 201)
	}
	call(admin, "POST", parent, input(ids[3], 63), 201)
	replacement := input(ids[1], 63)
	replacement["creator"] = true
	call(manager, "POST", path+"/grant-draft/preview", map[string]any{"add": []any{replacement}, "remove": []int64{grant}}, 200)

	before = len(readAuditEvents(t, stores.config.DatabaseURL))
	if _, err = conn.Exec(ctx, "REVOKE INSERT ON audit_events FROM ftp_master_app"); err != nil {
		t.Fatal(err)
	}
	call(manager, "POST", path+"/grant-draft", map[string]any{"add": []any{replacement}, "remove": []int64{grant}}, 500)
	if _, err = conn.Exec(ctx, "GRANT INSERT ON audit_events TO ftp_master_app"); err != nil {
		t.Fatal(err)
	}
	if len(readAuditEvents(t, stores.config.DatabaseURL)) != before {
		t.Fatal("failed transfer audited")
	}
	var still []struct {
		ID      int64 `json:"id"`
		Creator bool  `json:"creator"`
	}
	decode(t, call(admin, "GET", path+"/grants", nil, 200), &still)
	retained := false
	for _, g := range still {
		if g.ID == grant && g.Creator {
			retained = true
		}
	}
	if !retained {
		t.Fatal("audit failure removed original Creator")
	}
	call(manager, "POST", path+"/grant-draft", map[string]any{"add": []any{replacement}, "remove": []int64{grant}}, 204)
	var sources []struct {
		Grant struct {
			Creator     bool  `json:"creator"`
			PrincipalID int64 `json:"principalId"`
		} `json:"grant"`
	}
	decode(t, call(admin, "GET", path+"/grant-draft", nil, 200), &sources)
	if len(readAuditEvents(t, stores.config.DatabaseURL)) != before+3 {
		t.Fatal("transfer must audit removal, addition and draft summary")
	}
	found := false
	for _, s := range sources {
		if s.Grant.Creator && s.Grant.PrincipalID == ids[1] {
			found = true
		}
	}
	if !found {
		t.Fatal("Creator transfer missing")
	}
}
