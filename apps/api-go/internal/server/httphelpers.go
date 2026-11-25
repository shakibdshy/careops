// Pagination + cursor helpers shared by the domain handlers: opaque
// base64 cursors over the keyset key, with the page shape the shared
// cursor-page schema describes ({ items, nextCursor?, hasMore }).
package server

import (
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

func parseLimit(r *http.Request, def, max int) int {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return def
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 {
		return def
	}
	if limit > max {
		return max
	}
	return limit
}

func encodeCursor(id string) string {
	if id == "" {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString([]byte(id))
}

// parseAuditCursor decodes an (at, id) keyset cursor — shared by the audit,
// patients and appointments lists.
func parseAuditCursor(r *http.Request) (pgtype.Timestamptz, pgtype.UUID) {
	raw := r.URL.Query().Get("cursor")
	if raw == "" {
		return pgtype.Timestamptz{}, pgtype.UUID{}
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return pgtype.Timestamptz{}, pgtype.UUID{}
	}
	sep := strings.IndexByte(string(decoded), '|')
	if sep <= 0 {
		return pgtype.Timestamptz{}, pgtype.UUID{}
	}
	at, err := time.Parse(time.RFC3339Nano, string(decoded[:sep]))
	if err != nil {
		return pgtype.Timestamptz{}, pgtype.UUID{}
	}
	return pgtype.Timestamptz{Time: at, Valid: true}, uuidParam(string(decoded[sep+1:]))
}

func encodeAuditCursor(at time.Time, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(at.UTC().Format(time.RFC3339Nano) + "|" + id))
}

// writePatientPage renders a keyset page: one extra row was fetched purely
// to compute hasMore, so trim before writing.
func writePatientPage[T any](
	w http.ResponseWriter,
	rows []T,
	limit int,
	keyOf func(T) string,
	view func(T) any,
) {
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	items := make([]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, view(row))
	}
	page := map[string]any{"items": items, "hasMore": hasMore}
	if hasMore && len(rows) > 0 {
		page["nextCursor"] = encodeCursor(keyOf(rows[len(rows)-1]))
	}
	writeJSON(w, http.StatusOK, page)
}
