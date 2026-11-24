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
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_, _ = owner.Exec(cleanupCtx, `TRUNCATE audit_entry, patient, organization_member, organization, app_user CASCADE`)
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
}
