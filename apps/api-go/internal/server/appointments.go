// Appointments domain handlers (Go-T12): booking under the database-level
// Conflict rule (ADR-0019 — the exclusion constraint's 23P01 becomes the
// reference's 409), the full lifecycle matrix with the reference's error
// wording, reschedule semantics, and the audit trail atomically committed.
package server

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/shakibdshy/careops/api-go/internal/auth"
	"github.com/shakibdshy/careops/api-go/internal/db"
	"github.com/shakibdshy/careops/api-go/internal/store"
)

// Appointment is the wire shape of the contract's appointment schema.
type Appointment struct {
	ID              string  `json:"id"`
	OrganizationID  string  `json:"organizationId"`
	PatientID       string  `json:"patientId"`
	MemberID        string  `json:"memberId"`
	Start           string  `json:"start"`
	DurationMinutes int     `json:"durationMinutes"`
	Status          string  `json:"status"`
	Notes           *string `json:"notes,omitempty"`
	CreatedAt       string  `json:"createdAt"`
	UpdatedAt       string  `json:"updatedAt"`
}

func appointmentView(row store.Appointment) Appointment {
	return Appointment{
		ID:              auth.UIDString(row.ID),
		OrganizationID:  auth.UIDString(row.OrganizationID),
		PatientID:       auth.UIDString(row.PatientID),
		MemberID:        auth.UIDString(row.ProviderMemberID),
		Start:           row.StartsAt.Time.UTC().Format("2006-01-02T15:04:05.000Z"),
		DurationMinutes: int(row.DurationMinutes),
		Status:          row.Status,
		Notes:           pgTextPtr(row.Notes),
		CreatedAt:       row.CreatedAt.Time.UTC().Format("2006-01-02T15:04:05.000Z"),
		UpdatedAt:       row.UpdatedAt.Time.UTC().Format("2006-01-02T15:04:05.000Z"),
	}
}

func (a Appointment) auditSnapshot() map[string]any {
	raw, _ := json.Marshal(a)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return out
}

// allowedTransitions is the lifecycle matrix, transcribed from the shared
// rule — the same table the reference's transition guard encodes.
var allowedTransitions = map[string][]string{
	"SCHEDULED":   {"CONFIRMED", "CHECKED_IN", "CANCELLED", "NO_SHOW"},
	"CONFIRMED":   {"CHECKED_IN", "CANCELLED", "NO_SHOW"},
	"CHECKED_IN":  {"IN_PROGRESS", "COMPLETED", "CANCELLED"},
	"IN_PROGRESS": {"COMPLETED", "CANCELLED"},
	"COMPLETED":   {},
	"CANCELLED":   {},
	"NO_SHOW":     {},
}

const (
	minDuration = 15
	maxDuration = 480
)

// isExclusionViolation reports a Conflict-rule violation (the exclusion
// constraint's SQLSTATE).
func isExclusionViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.SQLState() == "23P01"
	}
	return false
}

func writeConflict(w http.ResponseWriter, message string, field string) {
	writeJSON(w, http.StatusConflict, map[string]any{
		"statusCode": http.StatusConflict,
		"message":    message,
		"errors":     []map[string]string{{"field": field, "message": message}},
	})
}

// parseStart normalizes an ISO-8601 datetime (offset allowed) to UTC.
func parseStart(raw string) (time.Time, bool) {
	start, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}, false
	}
	return start.UTC(), true
}

// appointmentBody is the create/reschedule payload.
type appointmentBody struct {
	PatientID       string  `json:"patientId"`
	MemberID        string  `json:"memberId"`
	Start           string  `json:"start"`
	DurationMinutes *int    `json:"durationMinutes"`
	Notes           *string `json:"notes"`
}

// PatientsControllerList implements GET /api/appointments: keyset pages with
// the contract's optional filters, all validated before querying.
func (s *Server) AppointmentsControllerList(w http.ResponseWriter, r *http.Request) {
	org, failure := s.resolve(r)
	if failure != nil {
		failure.write(w)
		return
	}
	ctx := r.Context()
	query := r.URL.Query()

	limit := parseLimit(r, 20, 100)
	cursorID := pgtype.UUID{}
	if raw := query.Get("cursor"); raw != "" {
		decoded, err := base64Decode(raw)
		if err != nil {
			writeTaxonomy(w, http.StatusBadRequest, "cursor must be a valid pagination cursor")
			return
		}
		cursorID = uuidParam(decoded)
		if !cursorID.Valid {
			writeTaxonomy(w, http.StatusBadRequest, "cursor must be a valid pagination cursor")
			return
		}
	}

	statusFilter := query.Get("status")
	if statusFilter != "" {
		if _, ok := allowedTransitions[statusFilter]; !ok {
			writeTaxonomy(w, http.StatusBadRequest, "status must be a valid appointment status")
			return
		}
	}

	memberFilter := pgtype.UUID{}
	if raw := query.Get("memberId"); raw != "" {
		memberFilter = uuidParam(raw)
		if !memberFilter.Valid {
			writeTaxonomy(w, http.StatusBadRequest, "memberId must be a valid identifier")
			return
		}
	}

	fromFilter, fromOK := parseStart(query.Get("from"))
	toFilter, toOK := parseStart(query.Get("to"))
	if query.Get("from") != "" && !fromOK {
		writeTaxonomy(w, http.StatusBadRequest, "from must be an ISO datetime")
		return
	}
	if query.Get("to") != "" && !toOK {
		writeTaxonomy(w, http.StatusBadRequest, "to must be an ISO datetime")
		return
	}
	if fromOK && toOK && fromFilter.After(toFilter) {
		writeTaxonomy(w, http.StatusBadRequest, "from must not be after to")
		return
	}

	var rows []store.Appointment
	err := db.OrgTx(ctx, s.cfg.Pool, org.OrganizationID, func(tx pgx.Tx) error {
		var err error
		rows, err = store.New(tx).ListAppointments(ctx, store.ListAppointmentsParams{
			Cursor: cursorID,
			Status: pgtype.Text{String: statusFilter, Valid: statusFilter != ""},
			Member: memberFilter,
			FromTs: pgtype.Timestamptz{Time: fromFilter, Valid: fromOK},
			ToTs:   pgtype.Timestamptz{Time: toFilter, Valid: toOK},
			Limit:  int32(limit + 1),
		})
		return err
	})
	if err != nil {
		writeTaxonomy(w, http.StatusInternalServerError, "failed to list appointments")
		return
	}
	writePatientPage(w, rows, limit,
		func(row store.Appointment) string { return auth.UIDString(row.ID) },
		func(row store.Appointment) any { return appointmentView(row) })
}

// base64Decode decodes the opaque id cursor.
func base64Decode(raw string) (string, error) {
	out, err := base64.RawURLEncoding.DecodeString(raw)
	return string(out), err
}

// AppointmentsControllerCreate implements POST /api/appointments.
func (s *Server) AppointmentsControllerCreate(w http.ResponseWriter, r *http.Request) {
	org, ok := s.requireManager(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	var body appointmentBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeTaxonomy(w, http.StatusBadRequest, "request body is not valid JSON")
		return
	}

	fieldErrors := []map[string]string{}
	if body.PatientID == "" || !isUUIDLike(body.PatientID) {
		fieldErrors = append(fieldErrors, map[string]string{"field": "patientId", "message": "must be an identifier"})
	}
	if body.MemberID == "" || !isUUIDLike(body.MemberID) {
		fieldErrors = append(fieldErrors, map[string]string{"field": "memberId", "message": "must be an identifier"})
	}
	if _, ok := parseStart(body.Start); !ok {
		fieldErrors = append(fieldErrors, map[string]string{"field": "start", "message": "must be an ISO datetime"})
	}
	if body.DurationMinutes == nil || *body.DurationMinutes < minDuration || *body.DurationMinutes > maxDuration {
		fieldErrors = append(fieldErrors, map[string]string{
			"field":   "durationMinutes",
			"message": fmt.Sprintf("must be between %d and %d minutes", minDuration, maxDuration),
		})
	}
	if len(fieldErrors) > 0 {
		writeFieldErrors(w, fieldErrors)
		return
	}
	start, _ := parseStart(body.Start)

	var created store.Appointment
	err := db.OrgTx(ctx, s.cfg.Pool, org.OrganizationID, func(tx pgx.Tx) error {
		queries := store.New(tx)

		patientPresent, err := queries.PatientExists(ctx, store.PatientExistsParams{
			ID:             uuidParam(body.PatientID),
			OrganizationID: uuidParam(org.OrganizationID),
		})
		if err != nil {
			return err
		}
		providerPresent, err := queries.ProviderExists(ctx, store.ProviderExistsParams{
			ID:             uuidParam(body.MemberID),
			OrganizationID: uuidParam(org.OrganizationID),
		})
		if err != nil {
			return err
		}
		if !patientPresent || !providerPresent {
			return errNotFound()
		}

		row, err := queries.CreateAppointment(ctx, store.CreateAppointmentParams{
			OrganizationID:   uuidParam(org.OrganizationID),
			PatientID:        uuidParam(body.PatientID),
			ProviderMemberID: uuidParam(body.MemberID),
			StartsAt:         pgtype.Timestamptz{Time: start, Valid: true},
			DurationMinutes:  int32(*body.DurationMinutes),
			Notes:            optText(body.Notes),
		})
		if err != nil {
			return err
		}
		created = row
		return writeAuditEntry(ctx, queries, org, "create", "appointment", auth.UIDString(row.ID),
			nil, appointmentView(row).auditSnapshot())
	})
	if err != nil {
		if isExclusionViolation(err) {
			writeConflict(w, "the provider already has an overlapping appointment in that slot", "start")
			return
		}
		writePatientWriteFailure(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, appointmentView(created))
}

// AppointmentsControllerFindOne implements GET /api/appointments/{id}.
func (s *Server) AppointmentsControllerFindOne(w http.ResponseWriter, r *http.Request, appointmentID string) {
	org, failure := s.resolve(r)
	if failure != nil {
		failure.write(w)
		return
	}
	ctx := r.Context()
	var row store.Appointment
	err := db.OrgTx(ctx, s.cfg.Pool, org.OrganizationID, func(tx pgx.Tx) error {
		var err error
		row, err = store.New(tx).GetAppointment(ctx, store.GetAppointmentParams{
			ID:             uuidParam(appointmentID),
			OrganizationID: uuidParam(org.OrganizationID),
		})
		return err
	})
	if err != nil {
		writeTaxonomy(w, http.StatusNotFound, "Appointment not found")
		return
	}
	writeJSON(w, http.StatusOK, appointmentView(row))
}

// AppointmentsControllerTransition implements POST /api/appointments/{id}/status:
// the lifecycle matrix, with forbidden edges naming the legal targets
// (or none) in the shared taxonomy.
func (s *Server) AppointmentsControllerTransition(w http.ResponseWriter, r *http.Request, appointmentID string) {
	org, ok := s.requireManager(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	var body struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Status == "" {
		writeFieldErrors(w, []map[string]string{{"field": "status", "message": "status is required"}})
		return
	}
	target := strings.ToUpper(body.Status)
	if _, known := allowedTransitions[target]; !known {
		writeFieldErrors(w, []map[string]string{{"field": "status", "message": "status must be a valid appointment status"}})
		return
	}

	var before, after store.Appointment
	err := db.OrgTx(ctx, s.cfg.Pool, org.OrganizationID, func(tx pgx.Tx) error {
		queries := store.New(tx)
		current, err := queries.GetAppointment(ctx, store.GetAppointmentParams{
			ID:             uuidParam(appointmentID),
			OrganizationID: uuidParam(org.OrganizationID),
		})
		if err != nil {
			return errNotFound()
		}
		before = current
		allowed := allowedTransitions[current.Status]
		if !contains(allowed, target) {
			message := fmt.Sprintf("cannot move from %s to %s — allowed next states: none", current.Status, target)
			if len(allowed) > 0 {
				message = fmt.Sprintf("cannot move from %s to %s — allowed next states: %s",
					current.Status, target, strings.Join(allowed, " or "))
			}
			writeConflict(w, message, "status")
			return errAbortSilently
		}
		after, err = queries.TransitionAppointment(ctx, store.TransitionAppointmentParams{
			ID:             current.ID,
			Status:         target,
			OrganizationID: uuidParam(org.OrganizationID),
		})
		if err != nil {
			return err
		}
		return writeAuditEntry(ctx, queries, org, "update", "appointment", auth.UIDString(after.ID),
			appointmentView(before).auditSnapshot(), appointmentView(after).auditSnapshot())
	})
	if errors.Is(err, errAbortSilently) {
		return
	}
	if err != nil {
		writePatientWriteFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, appointmentView(after))
}

// AppointmentsControllerReschedule implements PATCH /api/appointments/{id}:
// move start, duration, or provider; the Conflict rule re-runs (the
// exclusion constraint re-checks the new slot, self-excluded) and later
// states refuse the move structurally (the reschedule trigger).
func (s *Server) AppointmentsControllerReschedule(w http.ResponseWriter, r *http.Request, appointmentID string) {
	org, ok := s.requireManager(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	var body appointmentBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeTaxonomy(w, http.StatusBadRequest, "request body is not valid JSON")
		return
	}
	if body.Start == "" && body.DurationMinutes == nil && body.MemberID == "" {
		writeFieldErrors(w, []map[string]string{{"field": "body", "message": "at least one of start, durationMinutes, or memberId is required"}})
		return
	}
	fieldErrors := []map[string]string{}
	if body.Start != "" {
		if _, ok := parseStart(body.Start); !ok {
			fieldErrors = append(fieldErrors, map[string]string{"field": "start", "message": "must be an ISO datetime"})
		}
	}
	if body.DurationMinutes != nil && (*body.DurationMinutes < minDuration || *body.DurationMinutes > maxDuration) {
		fieldErrors = append(fieldErrors, map[string]string{
			"field":   "durationMinutes",
			"message": fmt.Sprintf("must be between %d and %d minutes", minDuration, maxDuration),
		})
	}
	if len(fieldErrors) > 0 {
		writeFieldErrors(w, fieldErrors)
		return
	}

	var before, after store.Appointment
	err := db.OrgTx(ctx, s.cfg.Pool, org.OrganizationID, func(tx pgx.Tx) error {
		queries := store.New(tx)
		current, err := queries.GetAppointment(ctx, store.GetAppointmentParams{
			ID:             uuidParam(appointmentID),
			OrganizationID: uuidParam(org.OrganizationID),
		})
		if err != nil {
			return errNotFound()
		}
		before = current
		if current.Status != "SCHEDULED" && current.Status != "CONFIRMED" {
			writeConflict(w, fmt.Sprintf("an appointment in %s cannot be rescheduled", current.Status), "status")
			return errAbortSilently
		}
		if body.MemberID != "" {
			providerPresent, err := queries.ProviderExists(ctx, store.ProviderExistsParams{
				ID:             uuidParam(body.MemberID),
				OrganizationID: uuidParam(org.OrganizationID),
			})
			if err != nil {
				return err
			}
			if !providerPresent {
				return errNotFound()
			}
		}
		after, err = queries.RescheduleAppointment(ctx, store.RescheduleAppointmentParams{
			ID:               current.ID,
			OrganizationID:   current.OrganizationID,
			StartsAt:         optTime(body.Start),
			DurationMinutes:  optInt4(body.DurationMinutes),
			ProviderMemberID: optUUID(body.MemberID),
			Notes:            optText(body.Notes),
		})
		if err != nil {
			return err
		}
		return writeAuditEntry(ctx, queries, org, "update", "appointment", auth.UIDString(after.ID),
			appointmentView(before).auditSnapshot(), appointmentView(after).auditSnapshot())
	})
	if errors.Is(err, errAbortSilently) {
		return
	}
	if err != nil {
		if isExclusionViolation(err) {
			writeConflict(w, "the provider already has an overlapping appointment in that slot", "start")
			return
		}
		if isRaiseException(err) {
			writeConflict(w, "an appointment in that state cannot be rescheduled", "status")
			return
		}
		writePatientWriteFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, appointmentView(after))
}

// errAbortSilently marks a failure whose response was already written.
var errAbortSilently = errors.New("response already written")

func contains(haystack []string, needle string) bool {
	for _, item := range haystack {
		if item == needle {
			return true
		}
	}
	return false
}

func isRaiseException(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.SQLState() == "P0001"
	}
	return false
}

func isUUIDLike(id string) bool {
	if len(id) != 36 {
		// The Mongo-reference scheme is 24 hex chars; the replica's is UUID.
		// Accept either shape as "well-formed enough" for existence checks —
		// format mismatch is a 400 only when clearly not an id at all.
		return len(id) == 24
	}
	return true
}

func optTime(raw string) pgtype.Timestamptz {
	if raw == "" {
		return pgtype.Timestamptz{}
	}
	start, ok := parseStart(raw)
	if !ok {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: start, Valid: true}
}

func optInt4(v *int) pgtype.Int4 {
	if v == nil {
		return pgtype.Int4{}
	}
	return pgtype.Int4{Int32: int32(*v), Valid: true}
}

func optUUID(id string) pgtype.UUID {
	if id == "" {
		return pgtype.UUID{}
	}
	return uuidParam(id)
}
