package db

// Database-level seam tests (Go-T06, spec #59): the guarantees that can only
// be observed against a real PostgreSQL. They run as the RESTRICTED app role
// against a migrated database — DATABASE_URL + MIGRATIONS_DATABASE_URL must
// point at one (compose: `bun run boot:infra`); without them the suite skips.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	orgA = "11111111-1111-4111-8111-111111111111"
	orgB = "22222222-2222-4222-8222-222222222222"
)

func seamEnv(t *testing.T) (appURL, ownerURL string) {
	t.Helper()
	appURL = os.Getenv("DATABASE_URL")
	ownerURL = os.Getenv("MIGRATIONS_DATABASE_URL")
	if appURL == "" || ownerURL == "" {
		t.Skip("DATABASE_URL / MIGRATIONS_DATABASE_URL not set — boot `docker compose up -d postgres` to run the seam tests")
	}
	return appURL, ownerURL
}

func pgErrCode(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}

// TestSeam proves the three guarantees the spec reserves for this seam, in
// dependency order inside one database (fresh org ids per run keep re-runs
// clean; migration idempotency is asserted first).
func TestSeam(t *testing.T) {
	appURL, ownerURL := seamEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Migration idempotency: applying twice is a no-op, not an error.
	for round := 1; round <= 2; round++ {
		if err := Migrate(ctx, ownerURL); err != nil {
			t.Fatalf("migrate round %d: %v", round, err)
		}
	}

	owner, err := pgx.Connect(ctx, ownerURL)
	if err != nil {
		t.Fatalf("owner connect: %v", err)
	}
	// Cleanup must run while the owner connection is still open, so the
	// truncate happens here rather than in a defer (t.Cleanup callbacks run
	// after the test function's defers would have closed the connection).
	// Cleanup is TARGETED: delete only the fixed test orgs and users. A full
	// TRUNCATE here would wipe the shared dev database's demo data every run
	// (learned the hard way — the demo org vanished under the browser check).
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		for _, id := range []string{orgA, orgB} {
			_, _ = owner.Exec(cleanupCtx,
				`DELETE FROM organization WHERE id = CAST($1 AS uuid)`, id)
		}
		_, _ = owner.Exec(cleanupCtx,
			`DELETE FROM app_user WHERE id = CAST($1 AS uuid) OR id = CAST($2 AS uuid)`, orgA, orgB)
		_ = owner.Close(cleanupCtx)
	})

	// Seed via the owner (superuser): org A and B, one patient each, one
	// audit entry. Fixed UUIDs keep failures debuggable; any residue from an
	// interrupted earlier run is removed first so seeding stays deterministic.
	seed := func() error {
		for _, stmt := range []string{
			`DELETE FROM audit_entry WHERE entity_id IN ('` + orgA + `', '` + orgB + `', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444')`,
			`DELETE FROM patient WHERE organization_id IN ('` + orgA + `', '` + orgB + `')`,
			`DELETE FROM organization WHERE id IN ('` + orgA + `', '` + orgB + `')`,
			`DELETE FROM app_user WHERE id IN ('` + orgA + `', '` + orgB + `')`,
			fmt.Sprintf(`INSERT INTO app_user (id, email, name, password_hash) VALUES ('%s', 'seam-a@t.test', 'A', 'x') ON CONFLICT DO NOTHING`, orgA),
			fmt.Sprintf(`INSERT INTO app_user (id, email, name, password_hash) VALUES ('%s', 'seam-b@t.test', 'B', 'x') ON CONFLICT DO NOTHING`, orgB),
			fmt.Sprintf(`INSERT INTO organization (id, name, owner_user_id) VALUES ('%s', 'Seam A', '%s') ON CONFLICT DO NOTHING`, orgA, orgA),
			fmt.Sprintf(`INSERT INTO organization (id, name, owner_user_id) VALUES ('%s', 'Seam B', '%s') ON CONFLICT DO NOTHING`, orgB, orgB),
			fmt.Sprintf(`INSERT INTO organization_member (organization_id, user_id, role) VALUES ('%s', '%s', 'owner') ON CONFLICT DO NOTHING`, orgA, orgA),
			fmt.Sprintf(`INSERT INTO patient (id, organization_id, first_name, last_name, date_of_birth) VALUES ('%s', '%s', 'Ann', 'A', '1990-01-01') ON CONFLICT DO NOTHING`, orgA, orgA),
			fmt.Sprintf(`INSERT INTO patient (id, organization_id, first_name, last_name, date_of_birth) VALUES ('%s', '%s', 'Bob', 'B', '1991-01-01') ON CONFLICT DO NOTHING`, orgB, orgB),
			fmt.Sprintf(`INSERT INTO audit_entry (organization_id, actor_id, actor_email, action, entity, entity_id, before, after) VALUES ('%s', '%s', 'seam-a@t.test', 'create', 'patient', '%s', NULL, '{}') ON CONFLICT DO NOTHING`, orgA, orgA, orgA),
		} {
			if _, err := owner.Exec(ctx, stmt); err != nil {
				return err
			}
		}
		return nil
	}
	if err := seed(); err != nil {
		t.Fatalf("seed: %v", err)
	}

	pool, err := pgxpool.New(ctx, appURL)
	if err != nil {
		t.Fatalf("app pool: %v", err)
	}
	defer pool.Close()

	t.Run("row level security hides other organizations", func(t *testing.T) {
		for _, tc := range []struct{ org, wantName string }{{orgA, "Ann"}, {orgB, "Bob"}} {
			if err := OrgTx(ctx, pool, tc.org, func(tx pgx.Tx) error {
				rows, err := tx.Query(ctx, `SELECT first_name FROM patient`)
				if err != nil {
					return err
				}
				defer rows.Close()
				var names []string
				for rows.Next() {
					var name string
					if err := rows.Scan(&name); err != nil {
						return err
					}
					names = append(names, name)
				}
				if len(names) != 1 || names[0] != tc.wantName {
					t.Errorf("org %s sees %v, want exactly [%s]", tc.org[:8], names, tc.wantName)
				}
				return nil
			}); err != nil && !t.Failed() {
				t.Fatalf("org %s query: %v", tc.org[:8], err)
			}
		}
	})

	t.Run("a connection without an organization scope sees nothing", func(t *testing.T) {
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM patient`).Scan(&count); err != nil {
			t.Fatalf("query: %v", err)
		}
		if count != 0 {
			t.Fatalf("unscoped connection sees %d patients, want 0", count)
		}
	})

	t.Run("a cross-organization insert violates the policy", func(t *testing.T) {
		err := OrgTx(ctx, pool, orgA, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx,
				`INSERT INTO patient (id, organization_id, first_name, last_name, date_of_birth)
				 VALUES (gen_random_uuid(), $1, 'Smuggled', 'Row', '1992-01-01')`, orgB)
			return err
		})
		if pgErrCode(err) != "42501" {
			t.Fatalf("cross-org insert err = %v, want a row-level-security violation (42501)", err)
		}
	})

	t.Run("a cross-organization update affects zero rows", func(t *testing.T) {
		var b1 string
		if err := owner.QueryRow(ctx, `SELECT id FROM patient WHERE organization_id = $1`, orgB).Scan(&b1); err != nil {
			t.Fatalf("fetch org B patient: %v", err)
		}
		if err := OrgTx(ctx, pool, orgA, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `UPDATE patient SET first_name = 'Hijacked' WHERE id = $1`, b1)
			return err
		}); err != nil {
			t.Fatalf("cross-org update: %v", err)
		}
		var name string
		if err := owner.QueryRow(ctx, `SELECT first_name FROM patient WHERE id = $1`, b1).Scan(&name); err != nil {
			t.Fatalf("re-read org B patient: %v", err)
		}
		if name != "Bob" {
			t.Fatalf("org B patient was renamed to %q by org A", name)
		}
	})

	t.Run("a transaction spanning two tables commits or rolls back as a whole", func(t *testing.T) {
		// Forced failure between the two writes: neither row may survive.
		err := OrgTx(ctx, pool, orgA, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx,
				`INSERT INTO patient (id, organization_id, first_name, last_name, date_of_birth)
				 VALUES ('33333333-3333-4333-8333-333333333333', $1, 'Roll', 'Back', '1993-01-01')`, orgA); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO audit_entry (organization_id, actor_id, actor_email, action, entity, entity_id)
				 VALUES ($1, $1, 'seam-a@t.test', 'create', 'patient', '33333333-3333-4333-8333-333333333333')`, orgA); err != nil {
				return err
			}
			return errors.New("forced failure after both writes")
		})
		if err == nil {
			t.Fatal("expected the forced failure to propagate")
		}
		var patients, entries int
		if err := owner.QueryRow(ctx, `SELECT count(*) FROM patient WHERE id = '33333333-3333-4333-8333-333333333333'`).Scan(&patients); err != nil {
			t.Fatal(err)
		}
		if err := owner.QueryRow(ctx,
			`SELECT count(*) FROM audit_entry WHERE entity_id = '33333333-3333-4333-8333-333333333333'`).Scan(&entries); err != nil {
			t.Fatal(err)
		}
		if patients != 0 || entries != 0 {
			t.Fatalf("rollback left rows behind: patients=%d audit=%d", patients, entries)
		}

		// Success path: both rows commit together.
		if err := OrgTx(ctx, pool, orgA, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx,
				`INSERT INTO patient (id, organization_id, first_name, last_name, date_of_birth)
				 VALUES ('44444444-4444-4444-8444-444444444444', $1, 'Commit', 'Both', '1994-01-01')`, orgA); err != nil {
				return err
			}
			_, err := tx.Exec(ctx,
				`INSERT INTO audit_entry (organization_id, actor_id, actor_email, action, entity, entity_id)
				 VALUES ($1, $1, 'seam-a@t.test', 'create', 'patient', '44444444-4444-4444-8444-444444444444')`, orgA)
			return err
		}); err != nil {
			t.Fatalf("commit path: %v", err)
		}
		if err := owner.QueryRow(ctx, `SELECT count(*) FROM patient WHERE id = '44444444-4444-4444-8444-444444444444'`).Scan(&patients); err != nil {
			t.Fatal(err)
		}
		if err := owner.QueryRow(ctx,
			`SELECT count(*) FROM audit_entry WHERE entity_id = '44444444-4444-4444-8444-444444444444'`).Scan(&entries); err != nil {
			t.Fatal(err)
		}
		if patients != 1 || entries != 1 {
			t.Fatalf("commit path lost rows: patients=%d audit=%d", patients, entries)
		}
	})

	t.Run("audit entries are append-only for the app role", func(t *testing.T) {
		err := OrgTx(ctx, pool, orgA, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `UPDATE audit_entry SET after = '{"tampered":true}' WHERE true`)
			return err
		})
		if pgErrCode(err) != "42501" {
			t.Fatalf("audit UPDATE err = %v, want permission denied (42501)", err)
		}
	})

	// Go-T12: the Conflict rule as a database guarantee under concurrency —
	// many bookings of the same Provider's slot arriving at the same instant
	// commit exactly one Appointment (and exactly one Audit Entry); the losers
	// abort on the exclusion constraint with no partial rows.
	t.Run("concurrent conflicting bookings commit exactly one appointment", func(t *testing.T) {
		provider := "55555555-5555-4555-8555-555555555555"
		slot := time.Now().UTC().Truncate(time.Minute).Add(72 * time.Hour)
		cleanup := func() {
			for _, stmt := range []string{
				`DELETE FROM appointment WHERE organization_id = '` + orgA + `' AND provider_member_id = '` + provider + `'`,
				`DELETE FROM audit_entry WHERE entity_id = '` + provider + `' AND entity = 'appointment'`,
				`DELETE FROM organization_member WHERE id = '` + provider + `'`,
				`DELETE FROM app_user WHERE id = '` + provider + `'`,
			} {
				_, _ = owner.Exec(ctx, stmt)
			}
		}
		cleanup()
		t.Cleanup(cleanup)
		// A distinct Provider Member (its own user — (organization_id, user_id)
		// is unique, and orgA's owner member already exists from the seed).
		if _, err := owner.Exec(ctx,
			`INSERT INTO app_user (id, email, name, password_hash)
			 VALUES ($1, 'seam-provider@t.test', 'P', 'x') ON CONFLICT DO NOTHING`, provider); err != nil {
			t.Fatalf("seed provider user: %v", err)
		}
		if _, err := owner.Exec(ctx,
			`INSERT INTO organization_member (id, organization_id, user_id, role)
			 VALUES ($1, $2, $1, 'admin') ON CONFLICT DO NOTHING`, provider, orgA); err != nil {
			t.Fatalf("seed provider member: %v", err)
		}

		const attempts = 8
		results := make(chan error, attempts)
		for i := 0; i < attempts; i++ {
			go func() {
				results <- OrgTx(ctx, pool, orgA, func(tx pgx.Tx) error {
					var id string
					if err := tx.QueryRow(ctx,
						`INSERT INTO appointment (organization_id, patient_id, provider_member_id, starts_at, duration_minutes, status)
						 VALUES ($1, (SELECT id FROM patient WHERE organization_id = $1 LIMIT 1), $2, $3, 30, 'SCHEDULED')
						 RETURNING id::text`, orgA, provider, slot).Scan(&id); err != nil {
						return err
					}
					_, err := tx.Exec(ctx,
						`INSERT INTO audit_entry (organization_id, actor_id, actor_email, action, entity, entity_id)
						 VALUES ($1, $1, 'seam-a@t.test', 'create', 'appointment', $2)`, orgA, id)
					return err
				})
			}()
		}
		wins, conflicts := 0, 0
		for i := 0; i < attempts; i++ {
			if err := <-results; err == nil {
				wins++
			} else if pgErrCode(err) == "23P01" {
				conflicts++
			} else {
				t.Fatalf("unexpected booking error: %v", err)
			}
		}
		if wins != 1 || conflicts != attempts-1 {
			t.Fatalf("concurrent bookings: %d wins / %d conflicts, want 1 / %d", wins, conflicts, attempts-1)
		}
		var appointments, entries int
		if err := owner.QueryRow(ctx,
			`SELECT count(*) FROM appointment WHERE organization_id = $1 AND provider_member_id = $2`, orgA, provider).Scan(&appointments); err != nil {
			t.Fatal(err)
		}
		// The winner's Audit Entry: entity_id is the winning Appointment's id.
		if err := owner.QueryRow(ctx,
			`SELECT count(*) FROM audit_entry WHERE organization_id = $1 AND entity = 'appointment'
			   AND entity_id IN (SELECT id FROM appointment WHERE organization_id = $1 AND provider_member_id = $2)`, orgA, provider).Scan(&entries); err != nil {
			t.Fatal(err)
		}
		if appointments != 1 || entries != 1 {
			t.Fatalf("database state after the race: appointments=%d audit=%d, want 1 / 1", appointments, entries)
		}
	})

	// Go-T13: state-based claiming is the at-least-once guarantee's dedupe —
	// two worker replicas claiming due jobs at the same instant must never
	// both win the same job (FOR UPDATE SKIP LOCKED).
	t.Run("two concurrent claimers never claim the same job", func(t *testing.T) {
		var jobID int64
		if err := owner.QueryRow(ctx,
			`INSERT INTO notification_job (kind, payload) VALUES ('appointment.reminder', '{"organizationId":"`+orgA+`","patientId":"`+orgA+`","appointmentId":"`+orgA+`","kind":"appointment.reminder"}')
			 RETURNING id`).Scan(&jobID); err != nil {
			t.Fatalf("seed job: %v", err)
		}
		t.Cleanup(func() {
			_, _ = owner.Exec(ctx, `DELETE FROM notification_job WHERE id = $1`, jobID)
		})

		claim := func() (int64, error) {
			var id int64
			err := OrgTx(ctx, pool, orgA, func(tx pgx.Tx) error {
				// The worker's claim shape: due pending jobs, FIFO, locked.
				rows, err := tx.Query(ctx,
					`UPDATE notification_job SET state = 'processing', attempts = attempts + 1
					 WHERE id IN (
					   SELECT id FROM notification_job
					   WHERE state = 'pending' AND run_at <= now()
					   ORDER BY id
					   FOR UPDATE SKIP LOCKED
					   LIMIT 1
					 )
					 RETURNING id`)
				if err != nil {
					return err
				}
				defer rows.Close()
				for rows.Next() {
					if err := rows.Scan(&id); err != nil {
						return err
					}
				}
				return rows.Err()
			})
			return id, err
		}

		type claimResult struct {
			id  int64
			err error
		}
		done := make(chan claimResult, 2)
		for i := 0; i < 2; i++ {
			go func() {
				id, err := claim()
				done <- claimResult{id, err}
			}()
		}
		claimed := []int64{}
		for i := 0; i < 2; i++ {
			r := <-done
			if r.err != nil {
				t.Fatalf("claim failed: %v", r.err)
			}
			if r.id != 0 {
				claimed = append(claimed, r.id)
			}
		}
		if len(claimed) != 1 || claimed[0] != jobID {
			t.Fatalf("claimers got %v, want exactly [%d]", claimed, jobID)
		}
	})
}
