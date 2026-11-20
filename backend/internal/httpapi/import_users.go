package httpapi

import (
	"context"
	"encoding/csv"
	"errors"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/audit"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"github.com/liumingjian/ftp-master/backend/internal/identity"
)

// ImportUsers validates every record before committing Users and their Audit Events together.
func (s *Server) ImportUsers(ctx context.Context, r api.ImportUsersRequestObject) (api.ImportUsersResponseObject, error) {
	info := requestFrom(ctx)
	if !info.session.User.IsAdministrator {
		return api.ImportUsersdefaultJSONResponse{StatusCode: 403, Body: api.Error{Code: "forbidden", Message: "Administrator required"}}, nil
	}
	report := api.ImportUsers422JSONResponse{}
	problem := func(row int, message string) {
		report.Errors = append(report.Errors, struct {
			Message string `json:"message"`
			Row     int    `json:"row"`
		}{message, row})
	}
	if r.Body == nil || len(r.Body.Csv) > 2*1024*1024 || !utf8.ValidString(r.Body.Csv) {
		problem(1, "UTF-8 CSV up to 2 MiB required")
		return report, nil
	}
	reader := csv.NewReader(strings.NewReader(strings.TrimPrefix(r.Body.Csv, "\ufeff")))
	reader.FieldsPerRecord = -1
	header, err := reader.Read()
	if err != nil || strings.Join(header, ",") != "username,display_name,password,organization_id" {
		problem(1, "expected header: username,display_name,password,organization_id")
		return report, nil
	}
	tx, err := s.membership.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	q := sqlcdb.New(tx)
	// Also blocks concurrent Registrations and account changes during validation.
	if err := q.LockUserImport(ctx); err != nil {
		return nil, err
	}
	organizations, err := q.ListOrganizations(ctx)
	if err != nil {
		return nil, err
	}
	orgIDs := map[int64]bool{}
	for _, o := range organizations {
		orgIDs[o.ID] = true
	}
	seen := map[string]int{}
	var rows []sqlcdb.CreateImportedUserParams
	for row := 2; ; row++ {
		fields, readErr := reader.Read()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if row > 1001 {
			problem(row, "at most 1000 Users per import")
			break
		}
		if readErr != nil {
			problem(row, "malformed CSV record")
			break
		}
		if len(fields) != 4 {
			problem(row, "four fields required")
			continue
		}
		username, display, password := strings.TrimSpace(fields[0]), strings.TrimSpace(fields[1]), fields[2]
		if username == "" || utf8.RuneCountInString(username) > 150 {
			problem(row, "username must contain 1 to 150 characters")
		}
		if display == "" || utf8.RuneCountInString(display) > 150 {
			problem(row, "display_name must contain 1 to 150 characters")
		}
		if password == "" || len(password) > 1024 {
			problem(row, "password must contain 1 to 1024 bytes")
		}
		key := strings.ToLower(username)
		if previous, ok := seen[key]; ok {
			problem(row, "duplicate username in file")
			problem(previous, "duplicate username in file")
		}
		seen[key] = row
		if _, err := q.GetUserByUsername(ctx, username); err == nil {
			problem(row, "username already exists")
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		orgID, parseErr := strconv.ParseInt(fields[3], 10, 64)
		if parseErr != nil || !orgIDs[orgID] {
			problem(row, "unknown organization_id")
		}
		rows = append(rows, sqlcdb.CreateImportedUserParams{Username: username, DisplayName: display, PasswordHash: password, OrganizationID: orgID, CreatedAt: pgtype.Timestamptz{Time: s.membership.Clock.Now(), Valid: true}})
	}
	if len(rows) == 0 && len(report.Errors) == 0 {
		problem(2, "at least one User required")
	}
	if len(report.Errors) > 0 {
		return report, nil
	}
	recorder := audit.NewRecorder(q, s.membership.Clock)
	for _, row := range rows {
		row.PasswordHash, err = identity.HashImportedPassword(row.PasswordHash)
		if err != nil {
			return nil, err
		}
		id, err := q.CreateImportedUser(ctx, row)
		if err != nil {
			return nil, err
		}
		if err := recorder.Record(ctx, audit.Event{UserID: info.session.User.ID, Username: info.session.User.Username, SourceIP: info.sourceIP, Action: "account_import", Outcome: audit.OutcomeSuccess, Detail: map[string]any{"target_user_id": id, "organization_id": row.OrganizationID}}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return api.ImportUsers201JSONResponse{Created: len(rows)}, nil
}
