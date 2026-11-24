package auth

import (
	"errors"
	"regexp"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

var emailPattern = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

// ValidEmail reports whether the address is shaped like one (a boolean, not
// a parsed mail.Address — the invitation validation needs a field name).
func ValidEmail(email string) bool {
	return emailPattern.MatchString(email)
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.SQLState() == "23505"
	}
	return false
}

func UIDString(id pgtype.UUID) string {
	if !id.Valid {
		return ""
	}
	raw, _ := id.Value()
	s, _ := raw.(string)
	return s
}

func UUIDParam(id string) pgtype.UUID {
	var out pgtype.UUID
	_ = out.Scan(id) // invalid input leaves the zero UUID; callers validate first
	return out
}

func pgtypeText(s string) pgtype.Text { return pgtype.Text{String: s, Valid: true} }
