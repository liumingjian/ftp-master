package httpapi

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/liumingjian/ftp-master/backend/internal/api"
	"github.com/liumingjian/ftp-master/backend/internal/db/sqlcdb"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
)

type auditQueryResponse struct {
	status int
	body   any
	csv    bool
}

func (r auditQueryResponse) VisitQueryAuditResponse(w http.ResponseWriter) error {
	if r.csv {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="audit.csv"`)
		writer := csv.NewWriter(w)
		if err := writer.Write([]string{"id", "time", "user_id", "username", "source_ip", "action", "outcome", "item_id", "path", "detail"}); err != nil {
			return err
		}
		for _, e := range r.body.([]auditQueryEvent) {
			record := []string{strconv.FormatInt(e.ID, 10), e.Time.Format(time.RFC3339), idText(e.UserID), e.Username, e.SourceIP, e.Action, e.Outcome, idText(e.ItemID), e.Path, string(e.Detail)}
			// Spreadsheet formula injection applies even to names and historical paths.
			for i, v := range record {
				if strings.ContainsAny(strings.TrimLeft(v, " \t\r\n")[:min(1, len(strings.TrimLeft(v, " \t\r\n")))], "=+-@") {
					record[i] = "'" + v
				}
			}
			if err := writer.Write(record); err != nil {
				return err
			}
		}
		writer.Flush()
		return writer.Error()
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(r.status)
	return json.NewEncoder(w).Encode(r.body)
}
func idText(v *int64) string {
	if v == nil {
		return ""
	}
	return strconv.FormatInt(*v, 10)
}
func auditValue[T any](p *T) (v T) {
	if p != nil {
		return *p
	}
	return
}

type auditQueryEvent struct {
	ID       int64           `json:"id"`
	Time     time.Time       `json:"time"`
	UserID   *int64          `json:"userId"`
	Username string          `json:"username"`
	SourceIP string          `json:"sourceIp"`
	Action   string          `json:"action"`
	Outcome  string          `json:"outcome"`
	ItemID   *int64          `json:"itemId"`
	Path     string          `json:"path"`
	Detail   json.RawMessage `json:"detail"`
}

func auditID(v pgtype.Int8) *int64 {
	if !v.Valid {
		return nil
	}
	return &v.Int64
}
func (s *Server) QueryAudit(ctx context.Context, r api.QueryAuditRequestObject) (api.QueryAuditResponseObject, error) {
	refuse := func(status int, message string) (api.QueryAuditResponseObject, error) {
		return auditQueryResponse{status: status, body: api.Error{Code: "audit_refused", Message: message}}, nil
	}
	if !requestFrom(ctx).session.User.IsAdministrator {
		return refuse(403, "Administrator required")
	}
	b := r.Body
	if b == nil || !b.To.After(b.From) || b.To.Sub(b.From) > 180*24*time.Hour || b.From.Second() != 0 || b.To.Second() != 0 || b.From.Nanosecond() != 0 || b.To.Nanosecond() != 0 {
		return refuse(400, "Choose a minute-precision range of at most 180 days")
	}
	page := auditValue(b.Page)
	if page == 0 {
		page = 1
	}
	if page < 1 || page > 1000000000 {
		return refuse(400, "Invalid page")
	}
	q := sqlcdb.New(s.membership.Pool)
	limit := int32(50)
	offset := int64(page-1) * 50
	if auditValue(b.Export) {
		limit = 0
		offset = 0
	}
	rows, err := q.QueryAuditEvents(ctx, sqlcdb.QueryAuditEventsParams{FromTime: pgtype.Timestamptz{Time: b.From, Valid: true}, ToTime: pgtype.Timestamptz{Time: b.To, Valid: true}, UserIds: append([]int64{}, auditValue(b.UserIds)...), OrganizationID: auditValue(b.OrganizationId), Action: auditValue(b.Action), Category: string(auditValue(b.Category)), FailuresOnly: auditValue(b.FailuresOnly), ItemID: auditValue(b.ItemId), Directory: auditDirectory(auditValue(b.Directory)), Recursive: b.IncludeSubdirectories == nil || *b.IncludeSubdirectories, PageLimit: limit, PageOffset: offset})
	if err != nil {
		return nil, err
	}
	events := make([]auditQueryEvent, 0, len(rows))
	for _, e := range rows {
		ip := ""
		if e.SourceIp != nil {
			ip = e.SourceIp.String()
		}
		events = append(events, auditQueryEvent{e.ID.Int64, e.OccurredAt.Time, auditID(e.UserID), e.Username, ip, e.Action, e.Outcome, auditID(e.ItemID), e.ItemPath.String, e.Detail})
	}
	if auditValue(b.Export) {
		return auditQueryResponse{csv: true, body: events}, nil
	}
	historical, err := q.AuditHistoricalPaths(ctx)
	if err != nil {
		return nil, err
	}
	dirs := map[string]bool{"/": true}
	for _, p := range historical {
		for p = path.Dir(p); p != "."; p = path.Dir(p) {
			dirs[p] = true
			if p == "/" {
				break
			}
		}
	}
	current, err := q.AuditCurrentDirectories(ctx)
	if err != nil {
		return nil, err
	}
	live := map[string]bool{"/": true}
	for _, p := range current {
		live[p] = true
	}
	type suggestion struct {
		Path   string `json:"path"`
		Exists bool   `json:"exists"`
	}
	suggestions := []suggestion{}
	for p := range dirs {
		suggestions = append(suggestions, suggestion{p, live[p]})
	}
	sort.Slice(suggestions, func(i, j int) bool { return suggestions[i].Path < suggestions[j].Path })
	total, err := q.CountAuditEvents(ctx, sqlcdb.CountAuditEventsParams{FromTime: pgtype.Timestamptz{Time: b.From, Valid: true}, ToTime: pgtype.Timestamptz{Time: b.To, Valid: true}, UserIds: append([]int64{}, auditValue(b.UserIds)...), OrganizationID: auditValue(b.OrganizationId), Action: auditValue(b.Action), Category: string(auditValue(b.Category)), FailuresOnly: auditValue(b.FailuresOnly), ItemID: auditValue(b.ItemId), Directory: auditDirectory(auditValue(b.Directory)), Recursive: b.IncludeSubdirectories == nil || *b.IncludeSubdirectories})
	if err != nil {
		return nil, err
	}

	return auditQueryResponse{status: 200, body: map[string]any{"events": events, "total": total, "page": page, "directories": suggestions}}, nil
}

func auditDirectory(p string) string {
	if p == "/" {
		return p
	}
	return strings.TrimRight(p, "/")
}
