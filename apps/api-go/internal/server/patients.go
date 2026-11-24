// Patients domain handlers (Go-T11): Manager-only mutations with an audit
// entry committed in the SAME transaction (ADR-0020), keyset-paginated
// reads (ADR-0008), and the shared taxonomy everywhere. Every query runs
// inside db.OrgTx, where row-level security re-checks the same Organization
// the query already scopes by (ADR-0018).
package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/shakibdshy/careops/api-go/internal/auth"
	"github.com/shakibdshy/careops/api-go/internal/db"
	"github.com/shakibdshy/careops/api-go/internal/notifications"
	"github.com/shakibdshy/careops/api-go/internal/store"
)

// Patient is the wire shape of the contract's patient schema: identifiers
// and timestamps as strings, date of birth normalized to UTC midnight.
type Patient struct {
	ID             string  `json:"id"`
	OrganizationID string  `json:"organizationId"`
	FirstName      string  `json:"firstName"`
	LastName       string  `json:"lastName"`
	DateOfBirth    string  `json:"dateOfBirth"`
	Phone          *string `json:"phone,omitempty"`
	ContactEmail   *string `json:"contactEmail,omitempty"`
	Notes          *string `json:"notes,omitempty"`
	CreatedAt      string  `json:"createdAt"`
	UpdatedAt      string  `json:"updatedAt"`
}

func patientView(row store.Patient) Patient {
	return Patient{
		ID:             auth.UIDString(row.ID),
		OrganizationID: auth.UIDString(row.OrganizationID),
		FirstName:      row.FirstName,
		LastName:       row.LastName,
		DateOfBirth:    row.DateOfBirth.Time.UTC().Format("2006-01-02T15:04:05.000Z"),
		Phone:          pgTextPtr(row.Phone),
		ContactEmail:   pgTextPtr(row.ContactEmail),
		Notes:          pgTextPtr(row.Notes),
		CreatedAt:      row.CreatedAt.Time.UTC().Format("2006-01-02T15:04:05.000Z"),
		UpdatedAt:      row.UpdatedAt.Time.UTC().Format("2006-01-02T15:04:05.000Z"),
	}
}

func pgTextPtr(t pgtype.Text) *string {
	if !t.Valid {
		return nil
	}
	v := t.String
	return &v
}

func (p Patient) auditSnapshot() map[string]any {
	raw, _ := json.Marshal(p)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return out
}

// requireManager resolves the org context and, when the caller is not a
// Manager, writes the reference's exact 403 wording.
func (s *Server) requireManager(w http.ResponseWriter, r *http.Request) (OrgContext, bool) {
	org, failure := s.resolve(r)
	if failure != nil {
		failure.write(w)
		return OrgContext{}, false
	}
	if !managerRoles[org.Role] {
		writeTaxonomy(w, http.StatusForbidden, org.forbiddenMessage())
		return OrgContext{}, false
	}
	return org, true
}

// createPatientInput validates a create/update payload against the shared
// create-patient rules, returning field-named taxonomy errors.
type patientInput struct {
	FirstName    string  `json:"firstName"`
	LastName     string  `json:"lastName"`
	DateOfBirth  string  `json:"dateOfBirth"`
	Phone        *string `json:"phone"`
	ContactEmail *string `json:"contactEmail"`
	Notes        *string `json:"notes"`
}

func (in *patientInput) fieldErrors(mode string) []map[string]string {
	errs := []map[string]string{}
	validateName := func(field, value string) {
		if (mode == "create" || value != "") && (len(value) < 1 || len(value) > 100) {
			errs = append(errs, map[string]string{"field": field, "message": "must be 1-100 characters"})
		}
	}
	validateName("firstName", in.FirstName)
	validateName("lastName", in.LastName)

	if mode == "create" || in.DateOfBirth != "" {
		dob, err := time.Parse("2006-01-02", in.DateOfBirth)
		if err != nil || !dob.Before(time.Now()) {
			message := "must be a date in the past (YYYY-MM-DD)"
			if err != nil {
				message = "must be a valid date (YYYY-MM-DD)"
			}
			errs = append(errs, map[string]string{"field": "dateOfBirth", "message": message})
		}
	}
	if in.Phone != nil && *in.Phone != "" && (len(*in.Phone) < 7 || len(*in.Phone) > 20) {
		errs = append(errs, map[string]string{"field": "phone", "message": "must be 7-20 characters"})
	}
	if in.ContactEmail != nil && *in.ContactEmail != "" && !auth.ValidEmail(*in.ContactEmail) {
		errs = append(errs, map[string]string{"field": "contactEmail", "message": "must be a valid email address"})
	}
	if in.Notes != nil && len(*in.Notes) > 2000 {
		errs = append(errs, map[string]string{"field": "notes", "message": "must be at most 2000 characters"})
	}
	return errs
}

// PatientsControllerCreate implements POST /api/patients.
func (s *Server) PatientsControllerCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	org, ok := s.requireManager(w, r)
	if !ok {
		return
	}
	var in patientInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeTaxonomy(w, http.StatusBadRequest, "request body is not valid JSON")
		return
	}
	if errs := in.fieldErrors("create"); len(errs) > 0 {
		writeFieldErrors(w, errs)
		return
	}
	dob, _ := time.Parse("2006-01-02", in.DateOfBirth)

	var created store.Patient
	err := db.OrgTx(ctx, s.cfg.Pool, org.OrganizationID, func(tx pgx.Tx) error {
		queries := store.New(tx)
		row, err := queries.CreatePatient(ctx, store.CreatePatientParams{
			OrganizationID: uuidParam(org.OrganizationID),
			FirstName:      in.FirstName,
			LastName:       in.LastName,
			DateOfBirth:    pgtype.Date{Time: dob.UTC(), Valid: true},
			Phone:          optText(in.Phone),
			ContactEmail:   optText(in.ContactEmail),
			Notes:          optText(in.Notes),
		})
		if err != nil {
			return err
		}
		created = row
		after := patientView(row).auditSnapshot()
		if err := notifications.EnqueuePatientCreated(ctx, tx, org.OrganizationID, auth.UIDString(row.ID)); err != nil {
			return err
		}
		return writeAuditEntry(ctx, queries, org, "create", "patient", auth.UIDString(row.ID), nil, after)
	})
	if err != nil {
		writePatientWriteFailure(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, patientView(created))
}

// PatientsControllerList implements GET /api/patients with keyset
// pagination: newest-first per Organization, cursor = last item's id
// (base64-encoded, opaque to callers).
func (s *Server) PatientsControllerList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	org, failure := s.resolve(r)
	if failure != nil {
		failure.write(w)
		return
	}
	limit := parseLimit(r, 20, 100)
	cursorID := parseCursor(r)

	var rows []store.Patient
	err := db.OrgTx(ctx, s.cfg.Pool, org.OrganizationID, func(tx pgx.Tx) error {
		var err error
		rows, err = store.New(tx).ListPatients(ctx, store.ListPatientsParams{
			Column1: cursorID,
			Limit:   int32(limit + 1),
		})
		return err
	})
	if err != nil {
		writeTaxonomy(w, http.StatusInternalServerError, "failed to list patients")
		return
	}
	writePatientPage(w, rows, limit,
		func(row store.Patient) string { return auth.UIDString(row.ID) },
		func(row store.Patient) any { return patientView(row) })
}

// PatientsControllerFindOne implements GET /api/patients/{id}: another
// Organization's patient is a 404, never a 403 (tenancy isolation).
func (s *Server) PatientsControllerFindOne(w http.ResponseWriter, r *http.Request, patientID string) {
	ctx := r.Context()
	org, failure := s.resolve(r)
	if failure != nil {
		failure.write(w)
		return
	}
	var row store.Patient
	err := db.OrgTx(ctx, s.cfg.Pool, org.OrganizationID, func(tx pgx.Tx) error {
		var err error
		row, err = store.New(tx).GetPatient(ctx, store.GetPatientParams{
			ID:             uuidParam(patientID),
			OrganizationID: uuidParam(org.OrganizationID),
		})
		return err
	})
	if err != nil {
		writeTaxonomy(w, http.StatusNotFound, "Patient not found")
		return
	}
	writeJSON(w, http.StatusOK, patientView(row))
}

// PatientsControllerUpdate implements PATCH /api/patients/{id}: partial
// update with the before→after snapshot captured atomically.
func (s *Server) PatientsControllerUpdate(w http.ResponseWriter, r *http.Request, patientID string) {
	ctx := r.Context()
	org, ok := s.requireManager(w, r)
	if !ok {
		return
	}
	var in patientInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeTaxonomy(w, http.StatusBadRequest, "request body is not valid JSON")
		return
	}
	if errs := in.fieldErrors("update"); len(errs) > 0 {
		writeFieldErrors(w, errs)
		return
	}

	var updated store.Patient
	err := db.OrgTx(ctx, s.cfg.Pool, org.OrganizationID, func(tx pgx.Tx) error {
		queries := store.New(tx)
		before, err := queries.GetPatient(ctx, store.GetPatientParams{
			ID:             uuidParam(patientID),
			OrganizationID: uuidParam(org.OrganizationID),
		})
		if err != nil {
			return errNotFound()
		}
		after, err := queries.UpdatePatient(ctx, store.UpdatePatientParams{
			ID:             before.ID,
			OrganizationID: before.OrganizationID,
			FirstName:      optTextPatch(in.FirstName),
			LastName:       optTextPatch(in.LastName),
			Phone:          optText(in.Phone),
			ContactEmail:   optText(in.ContactEmail),
			Notes:          optText(in.Notes),
		})
		if err != nil {
			return err
		}
		updated = after
		return writeAuditEntry(ctx, queries, org, "update", "patient", auth.UIDString(after.ID),
			patientView(before).auditSnapshot(), patientView(after).auditSnapshot())
	})
	if err != nil {
		writePatientWriteFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, patientView(updated))
}

// PatientsControllerRemove implements DELETE /api/patients/{id}: the
// before-state is retained as the audit recovery record (null after).
func (s *Server) PatientsControllerRemove(w http.ResponseWriter, r *http.Request, patientID string) {
	ctx := r.Context()
	org, ok := s.requireManager(w, r)
	if !ok {
		return
	}
	err := db.OrgTx(ctx, s.cfg.Pool, org.OrganizationID, func(tx pgx.Tx) error {
		queries := store.New(tx)
		before, err := queries.GetPatient(ctx, store.GetPatientParams{
			ID:             uuidParam(patientID),
			OrganizationID: uuidParam(org.OrganizationID),
		})
		if err != nil {
			return errNotFound()
		}
		if err := queries.DeletePatient(ctx, store.DeletePatientParams{
			ID:             before.ID,
			OrganizationID: before.OrganizationID,
		}); err != nil {
			return err
		}
		return writeAuditEntry(ctx, queries, org, "delete", "patient", auth.UIDString(before.ID),
			patientView(before).auditSnapshot(), nil)
	})
	if err != nil {
		writePatientWriteFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// AuditControllerList implements GET /api/audit-entries: newest-first
// browsing with a (at, id) keyset cursor.
func (s *Server) AuditControllerList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	org, failure := s.resolve(r)
	if failure != nil {
		failure.write(w)
		return
	}
	if !managerRoles[org.Role] {
		writeTaxonomy(w, http.StatusForbidden, org.forbiddenMessage())
		return
	}
	limit := parseLimit(r, 20, 100)
	cursorAt, cursorID := parseAuditCursor(r)

	var rows []store.AuditEntry
	err := db.OrgTx(ctx, s.cfg.Pool, org.OrganizationID, func(tx pgx.Tx) error {
		var err error
		rows, err = store.New(tx).ListAuditEntries(ctx, store.ListAuditEntriesParams{
			Column1: cursorAt,
			Column2: cursorID,
			Limit:   int32(limit + 1),
		})
		return err
	})
	if err != nil {
		writeTaxonomy(w, http.StatusInternalServerError, "failed to list audit entries")
		return
	}

	items := make([]map[string]any, 0, len(rows))
	lastAt := time.Time{}
	lastID := ""
	for _, row := range rows {
		items = append(items, auditView(row))
		lastAt, lastID = row.At.Time, auth.UIDString(row.ID)
	}
	hasMore := len(rows) > limit
	if hasMore {
		items = items[:limit]
	}
	page := map[string]any{"items": items, "hasMore": hasMore}
	if hasMore && lastID != "" {
		page["nextCursor"] = encodeAuditCursor(lastAt, lastID)
	}
	writeJSON(w, http.StatusOK, page)
}

func auditView(row store.AuditEntry) map[string]any {
	return map[string]any{
		"id":             auth.UIDString(row.ID),
		"organizationId": auth.UIDString(row.OrganizationID),
		"actorId":        auth.UIDString(row.ActorID),
		"actorEmail":     row.ActorEmail,
		"action":         row.Action,
		"entity":         row.Entity,
		"entityId":       auth.UIDString(row.EntityID),
		"before":         jsonOrNull(row.Before),
		"after":          jsonOrNull(row.After),
		"at":             row.At.Time.UTC().Format("2006-01-02T15:04:05.000Z"),
	}
}

func jsonOrNull(raw []byte) any {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil
	}
	return v
}

// --- shared helpers ----------------------------------------------------------

func writeAuditEntry(
	ctx context.Context,
	queries *store.Queries,
	org OrgContext,
	action, entity, entityID string,
	before, after map[string]any,
) error {
	beforeJSON, err := json.Marshal(before)
	if before == nil {
		beforeJSON = []byte("null")
	}
	if err != nil {
		return err
	}
	afterJSON, err := json.Marshal(after)
	if after == nil {
		afterJSON = []byte("null")
	}
	if err != nil {
		return err
	}
	return queries.InsertAuditEntry(ctx, store.InsertAuditEntryParams{
		OrganizationID: uuidParam(org.OrganizationID),
		ActorID:        uuidParam(org.UserID),
		ActorEmail:     org.Email,
		Action:         action,
		Entity:         entity,
		EntityID:       uuidParam(entityID),
		Before:         jsonbOrNull(beforeJSON),
		After:          jsonbOrNull(afterJSON),
	})
}

func writePatientWriteFailure(w http.ResponseWriter, err error) {
	if isNotFound(err) {
		writeTaxonomy(w, http.StatusNotFound, "Patient not found")
		return
	}
	slog.Error("patient write failed", "err", err)
	writeTaxonomy(w, http.StatusInternalServerError, "patient write failed")
}

func writeFieldErrors(w http.ResponseWriter, errs []map[string]string) {
	writeJSON(w, http.StatusBadRequest, map[string]any{
		"statusCode": http.StatusBadRequest,
		"message":    "Validation failed",
		"errors":     errs,
	})
}

func optText(v *string) pgtype.Text {
	if v == nil || *v == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *v, Valid: true}
}

// optTextPatch treats an absent field (nil) as "keep", and an empty string
// as "clear" — mirroring the reference's partial-update semantics.
func optTextPatch(v string) pgtype.Text {
	if v == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: v, Valid: true}
}

func errNotFound() error { return pgx.ErrNoRows }

func isNotFound(err error) bool { return strings.Contains(err.Error(), pgx.ErrNoRows.Error()) }

func jsonbOrNull(raw []byte) []byte {
	if raw == nil || string(raw) == "null" {
		return []byte("null")
	}
	return raw
}
