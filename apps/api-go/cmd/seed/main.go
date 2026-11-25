// The Go replica's demo seed (Go-T18): creates the same demo dataset as
// apps/api/src/seed.ts — the same demo Organization and Members (same emails,
// names, and demo password), the same four demo Patients, the same clinic
// week of Appointments relative to the seed day in UTC, their Audit Entries,
// and the Reminder jobs for tomorrow's upcoming visits — so both live links
// show identical demo data behind identical demo credentials.
//
// Safe to re-run: Member passwords refresh in place; the domain data seeds
// once (the reference skips the whole seed when the demo owner exists — the
// same once-only semantics keyed here on the Organization's Patient count).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shakibdshy/careops/api-go/internal/auth"
	"github.com/shakibdshy/careops/api-go/internal/config"
	"github.com/shakibdshy/careops/api-go/internal/db"
	"github.com/shakibdshy/careops/api-go/internal/notifications"
	"github.com/shakibdshy/careops/api-go/internal/store"
)

// demoMember mirrors apps/api/src/seed.ts's demo trio.
type demoMember struct {
	email string
	name  string
	role  string
}

var demoMembers = []demoMember{
	{email: "owner@demo.careops", name: "Dana Owner", role: "owner"},
	{email: "admin@demo.careops", name: "Alex Admin", role: "admin"},
	{email: "member@demo.careops", name: "Morgan Member", role: "member"},
}

const (
	// demoPassword is the same shared demo credential the reference seeds.
	demoPassword = "careops-demo-1"
	// demoOrgSlug is fixed so re-runs and the parity check key on the same org.
	demoOrgSlug = "careops-demo"
)

// demoPatient mirrors the reference seed's four Patients — same names, birth
// dates, contact emails, and notes. Empty phone/notes mean the field is
// absent, exactly like the reference's omitted properties.
type demoPatient struct {
	firstName    string
	lastName     string
	dateOfBirth  string
	phone        string
	contactEmail string
	notes        string
}

var demoPatients = []demoPatient{
	{firstName: "Ada", lastName: "Lovelace", dateOfBirth: "1990-12-10",
		phone: "555-0100", contactEmail: "ada.lovelace@example.test",
		notes: "Prefers morning appointments."},
	{firstName: "Grace", lastName: "Hopper", dateOfBirth: "1944-06-09",
		phone: "555-0101", contactEmail: "grace.hopper@example.test",
		notes: "Coordinate with her aide."},
	{firstName: "Alan", lastName: "Turing", dateOfBirth: "1982-05-14",
		contactEmail: "alan.turing@example.test"},
	{firstName: "Katherine", lastName: "Johnson", dateOfBirth: "1978-11-05",
		contactEmail: "katherine.johnson@example.test",
		notes:        "Follow-up in two weeks."},
}

// demoAppointment mirrors the reference seed's AppointmentFixture: one clinic
// week relative to the seed day, in UTC. Every Provider's slots are disjoint,
// so the demo data satisfies the same Conflict invariant the API enforces;
// all seven lifecycle statuses appear.
type demoAppointment struct {
	dayOffset       int
	hour            int
	durationMinutes int
	status          string
	patientIndex    int
	provider        string // the demo Member role
	notes           string
}

var pastWeek = []int{-7, -6, -5, -4, -3, -2, -1}

var demoAppointments = func() []demoAppointment {
	fixtures := []demoAppointment{}
	// Completed visits across the past week feed the dashboard's volume trend.
	for _, dayOffset := range pastWeek {
		fixtures = append(fixtures,
			demoAppointment{dayOffset: dayOffset, hour: 9, durationMinutes: 30,
				status: "COMPLETED", patientIndex: abs(dayOffset) % len(demoPatients), provider: "owner"},
			demoAppointment{dayOffset: dayOffset, hour: 10, durationMinutes: 30,
				status: "COMPLETED", patientIndex: (abs(dayOffset) + 1) % len(demoPatients), provider: "admin"},
		)
	}
	// Terminal outcomes in the recent past feed the status-breakdown rates.
	fixtures = append(fixtures,
		demoAppointment{dayOffset: -2, hour: 11, durationMinutes: 30,
			status: "CANCELLED", patientIndex: 1, provider: "member",
			notes: "Patient requested a later date."},
		demoAppointment{dayOffset: -3, hour: 14, durationMinutes: 30,
			status: "NO_SHOW", patientIndex: 2, provider: "owner"},
	)
	// Today: the clinic is mid-flow.
	fixtures = append(fixtures,
		demoAppointment{dayOffset: 0, hour: 9, durationMinutes: 30,
			status: "CHECKED_IN", patientIndex: 0, provider: "owner", notes: "Arrived early."},
		demoAppointment{dayOffset: 0, hour: 9, durationMinutes: 60,
			status: "IN_PROGRESS", patientIndex: 1, provider: "admin"},
		demoAppointment{dayOffset: 0, hour: 14, durationMinutes: 30,
			status: "SCHEDULED", patientIndex: 3, provider: "owner"},
		demoAppointment{dayOffset: 0, hour: 15, durationMinutes: 30,
			status: "SCHEDULED", patientIndex: 2, provider: "member"},
	)
	// Tomorrow: upcoming visits, some already confirmed — the reminder
	// candidates (start − 24h).
	fixtures = append(fixtures,
		demoAppointment{dayOffset: 1, hour: 9, durationMinutes: 30,
			status: "SCHEDULED", patientIndex: 0, provider: "owner"},
		demoAppointment{dayOffset: 1, hour: 10, durationMinutes: 30,
			status: "SCHEDULED", patientIndex: 1, provider: "admin"},
		demoAppointment{dayOffset: 1, hour: 11, durationMinutes: 30,
			status: "CONFIRMED", patientIndex: 2, provider: "owner"},
		demoAppointment{dayOffset: 1, hour: 14, durationMinutes: 30,
			status: "CONFIRMED", patientIndex: 3, provider: "member"},
	)
	return fixtures
}()

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

func text(s string) pgtype.Text {
	return pgtype.Text{String: s, Valid: s != ""}
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	cfg, err := config.Load()
	if err != nil {
		slog.Error("invalid configuration", "err", err)
		os.Exit(1)
	}

	ctx := context.Background()
	if err := db.Migrate(ctx, cfg.MigrationsDatabaseURL); err != nil {
		slog.Error("migrations failed", "err", err)
		os.Exit(1)
	}
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("database connect failed", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	hash, err := auth.HashPassword(demoPassword)
	if err != nil {
		slog.Error("hash demo password failed", "err", err)
		os.Exit(1)
	}

	for _, member := range demoMembers {
		if _, err := pool.Exec(ctx,
			`INSERT INTO app_user (email, name, password_hash)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
			member.email, member.name, hash); err != nil {
			slog.Error("seed member failed", "email", member.email, "err", err)
			os.Exit(1)
		}
	}

	// The Organization is created the same way the reference's signup hook
	// names it ('<Owner>'s Organization', slug careops-demo), owned by the
	// demo owner, with all three demo Members inside it.
	if _, err := pool.Exec(ctx,
		`INSERT INTO organization (name, slug, owner_user_id)
		 SELECT $1, $2, id FROM app_user WHERE email = $3
		 ON CONFLICT (slug) DO NOTHING`,
		"Dana Owner's Organization", demoOrgSlug, demoMembers[0].email); err != nil {
		slog.Error("seed organization failed", "err", err)
		os.Exit(1)
	}
	for _, member := range demoMembers {
		if _, err := pool.Exec(ctx,
			`INSERT INTO organization_member (organization_id, user_id, role)
			 SELECT o.id, u.id, CAST($1 AS text)
			 FROM organization o, app_user u
			 WHERE o.slug = CAST($3 AS text) AND u.email = CAST($2 AS text)
			 ON CONFLICT (organization_id, user_id) DO NOTHING`,
			member.role, member.email, demoOrgSlug); err != nil {
			slog.Error("seed membership failed", "email", member.email, "err", err)
			os.Exit(1)
		}
	}

	// Domain data (Patients, Appointments, their Audit Entries, the Reminder
	// jobs): seeded once, keyed on the Organization's Patient count — the
	// same once-only semantics as the reference's owner-exists skip.
	var orgID, ownerID pgtype.UUID
	var ownerEmail string
	if err := pool.QueryRow(ctx,
		`SELECT o.id, o.owner_user_id, u.email
		 FROM organization o JOIN app_user u ON u.id = o.owner_user_id
		 WHERE o.slug = $1`, demoOrgSlug).Scan(&orgID, &ownerID, &ownerEmail); err != nil {
		slog.Error("demo organization missing", "err", err)
		os.Exit(1)
	}
	// Counted inside the org scope: row-level security binds every role
	// (migration 0009), so an unscoped count would always see zero.
	var patientCount int
	if err := db.OrgTx(ctx, pool, auth.UIDString(orgID), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT count(*) FROM patient WHERE organization_id = $1`, orgID).Scan(&patientCount)
	}); err != nil {
		slog.Error("count demo patients failed", "err", err)
		os.Exit(1)
	}

	reminders := 0
	if patientCount == 0 {
		var err error
		reminders, err = seedDomainData(ctx, pool, orgID, ownerID, ownerEmail)
		if err != nil {
			slog.Error("seed domain data failed", "err", err)
			os.Exit(1)
		}
	}

	slog.Info("demo seed complete",
		"organization", "Dana Owner's Organization (slug "+demoOrgSlug+")",
		"members", len(demoMembers),
		"patients", len(demoPatients),
		"appointments", len(demoAppointments),
		"reminders", reminders,
		"credentials", "owner@demo.careops / "+demoPassword,
	)
}

// seedDomainData inserts the demo Patients, the clinic-week Appointments and
// their Audit Entries in one org-scoped transaction (row-level security pins
// the same Organization as a second guard), then enqueues the Reminder jobs
// for tomorrow's upcoming visits — the same delayed jobs the booking path
// would have scheduled (start − 24h, due now if that moment passed).
func seedDomainData(ctx context.Context, pool *pgxpool.Pool, orgID, ownerID pgtype.UUID, ownerEmail string) (int, error) {
	// Provider = the Member assigned to the Appointment (glossary), resolved
	// by role exactly like the reference resolves its demo members.
	memberByRole := map[string]pgtype.UUID{}
	rows, err := pool.Query(ctx,
		`SELECT role, id FROM organization_member WHERE organization_id = $1`, orgID)
	if err != nil {
		return 0, err
	}
	for rows.Next() {
		var role string
		var id pgtype.UUID
		if err := rows.Scan(&role, &id); err != nil {
			return 0, err
		}
		memberByRole[role] = id
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}

	seedDay := time.Now().UTC().Truncate(24 * time.Hour)
	patientIDs := make([]pgtype.UUID, 0, len(demoPatients))
	enqueuedReminders := 0

	err = db.OrgTx(ctx, pool, auth.UIDString(orgID), func(tx pgx.Tx) error {
		queries := store.New(tx)
		for _, patient := range demoPatients {
			dob, err := time.Parse("2006-01-02", patient.dateOfBirth)
			if err != nil {
				return err
			}
			row, err := queries.CreatePatient(ctx, store.CreatePatientParams{
				OrganizationID: orgID,
				FirstName:      patient.firstName,
				LastName:       patient.lastName,
				DateOfBirth:    pgtype.Date{Time: dob, Valid: true},
				Phone:          text(patient.phone),
				ContactEmail:   text(patient.contactEmail),
				Notes:          text(patient.notes),
			})
			if err != nil {
				return err
			}
			patientIDs = append(patientIDs, row.ID)
			// The same before→after audit snapshot the API's create writes
			// (the wire view's keys; absent fields stay absent).
			after, err := json.Marshal(patientAuditSnapshot(patient, dob))
			if err != nil {
				return err
			}
			if err := queries.InsertAuditEntry(ctx, store.InsertAuditEntryParams{
				OrganizationID: orgID,
				ActorID:        ownerID,
				ActorEmail:     ownerEmail,
				Action:         "create",
				Entity:         "patient",
				EntityID:       row.ID,
				After:          after,
			}); err != nil {
				return err
			}
		}

		for _, fixture := range demoAppointments {
			start := seedDay.Add(time.Duration(fixture.dayOffset) * 24 * time.Hour).
				Add(time.Duration(fixture.hour) * time.Hour)
			provider, ok := memberByRole[fixture.provider]
			if !ok {
				return fmt.Errorf("demo organization has no %s member", fixture.provider)
			}
			// Status-bearing insert (the fixtures span all seven lifecycle
			// states; the API only creates SCHEDULED): direct SQL, same
			// as the reference seed writing collections by hand. The slot
			// trigger and the Conflict constraint apply unchanged.
			var appointmentID pgtype.UUID
			if err := tx.QueryRow(ctx,
				`INSERT INTO appointment (organization_id, patient_id, provider_member_id, starts_at, duration_minutes, status, notes)
				 VALUES ($1, $2, $3, $4, $5, $6, $7)
				 RETURNING id`,
				orgID, patientIDs[fixture.patientIndex], provider,
				pgtype.Timestamptz{Time: start, Valid: true}, fixture.durationMinutes,
				fixture.status, text(fixture.notes),
			).Scan(&appointmentID); err != nil {
				return err
			}
			after, err := json.Marshal(map[string]any{
				"patientId":       auth.UIDString(patientIDs[fixture.patientIndex]),
				"memberId":        auth.UIDString(provider),
				"start":           isoMilli(start),
				"end":             isoMilli(start.Add(time.Duration(fixture.durationMinutes) * time.Minute)),
				"durationMinutes": fixture.durationMinutes,
				"status":          fixture.status,
			})
			if err != nil {
				return err
			}
			if err := queries.InsertAuditEntry(ctx, store.InsertAuditEntryParams{
				OrganizationID: orgID,
				ActorID:        ownerID,
				ActorEmail:     ownerEmail,
				Action:         "create",
				Entity:         "appointment",
				EntityID:       appointmentID,
				After:          after,
			}); err != nil {
				return err
			}
			// Tomorrow's SCHEDULED/CONFIRMED visits are the reminder
			// candidates: a delayed job at start − 24h.
			if fixture.dayOffset == 1 && (fixture.status == "SCHEDULED" || fixture.status == "CONFIRMED") {
				if err := notifications.EnqueueReminder(ctx, tx, auth.UIDString(orgID),
					auth.UIDString(appointmentID), auth.UIDString(patientIDs[fixture.patientIndex]), start); err != nil {
					return err
				}
				enqueuedReminders++
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return enqueuedReminders, nil
}

// patientAuditSnapshot mirrors the API's patient create snapshot: the wire
// view's keys with absent fields left absent.
func patientAuditSnapshot(patient demoPatient, dob time.Time) map[string]any {
	out := map[string]any{
		"firstName":    patient.firstName,
		"lastName":     patient.lastName,
		"dateOfBirth":  isoMilli(dob),
		"contactEmail": patient.contactEmail,
	}
	if patient.phone != "" {
		out["phone"] = patient.phone
	}
	if patient.notes != "" {
		out["notes"] = patient.notes
	}
	return out
}

// isoMilli is the wire's timestamp format (the reference's toISOString).
func isoMilli(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
