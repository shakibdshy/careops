package store

// Smoke test for the generated store (Go-T06): proves the compile-time-typed
// queries round-trip against a real PostgreSQL inside an Organization scope.
// Env-gated like the seam tests: DATABASE_URL (app role) and
// MIGRATIONS_DATABASE_URL (owner) must point at a migrated-capable database.
import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shakibdshy/careops/api-go/internal/db"
)

func TestPatientQueriesRoundTrip(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	migrationsURL := os.Getenv("MIGRATIONS_DATABASE_URL")
	if databaseURL == "" || migrationsURL == "" {
		t.Skip("DATABASE_URL / MIGRATIONS_DATABASE_URL not set — boot `docker compose up -d postgres` to run the store tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := db.Migrate(ctx, migrationsURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	owner, err := pgx.Connect(ctx, migrationsURL)
	if err != nil {
		t.Fatalf("owner connect: %v", err)
	}
	// Cleanup runs while the owner connection is still open (same ordering
	// rule as the seam tests).
	const orgID = "55555555-5555-4555-8555-555555555555"
	const userID = "56565656-5656-4656-8656-565656565656"
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = owner.Exec(cleanupCtx, `DELETE FROM organization WHERE id = $1`, orgID)
		_, _ = owner.Exec(cleanupCtx, `DELETE FROM app_user WHERE id = $1`, userID)
		_ = owner.Close(cleanupCtx)
	})

	// Seed the identity plane as the owner (superuser), then exercise the
	// generated queries inside an Organization scope as the app role.
	if _, err := owner.Exec(ctx,
		`INSERT INTO app_user (id, email, name, password_hash) VALUES ($1, 'store@t.test', 'Store', 'x')
		 ON CONFLICT DO NOTHING`, userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := owner.Exec(ctx,
		`INSERT INTO organization (id, name, owner_user_id) VALUES ($1, 'Store Org', $2)
		 ON CONFLICT DO NOTHING`, orgID, userID); err != nil {
		t.Fatalf("seed org: %v", err)
	}

	org := pgtype.UUID{Bytes: [16]byte{0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x45, 0x55, 0x85, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55}, Valid: true}

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("app pool: %v", err)
	}
	defer pool.Close()

	var created Patient
	if err := db.OrgTx(ctx, pool, orgID, func(tx pgx.Tx) error {
		created, err = New(tx).CreatePatient(ctx, CreatePatientParams{
			OrganizationID: org,
			FirstName:      "Store",
			LastName:       "RoundTrip",
			DateOfBirth:    pgtype.Date{Time: time.Date(1995, 5, 5, 0, 0, 0, 0, time.UTC), Valid: true},
		})
		return err
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.OrganizationID.String() != orgID || created.FirstName != "Store" {
		t.Fatalf("created = %+v", created)
	}

	if err := db.OrgTx(ctx, pool, orgID, func(tx pgx.Tx) error {
		got, err := New(tx).GetPatient(ctx, GetPatientParams{ID: created.ID, OrganizationID: org})
		if err != nil {
			return err
		}
		if got.ID != created.ID {
			t.Fatalf("get returned %s, want %s", got.ID, created.ID)
		}
		return nil
	}); err != nil {
		t.Fatalf("get: %v", err)
	}

	if err := db.OrgTx(ctx, pool, orgID, func(tx pgx.Tx) error {
		return New(tx).DeletePatient(ctx, DeletePatientParams{ID: created.ID, OrganizationID: org})
	}); err != nil {
		t.Fatalf("delete: %v", err)
	}

	if err := db.OrgTx(ctx, pool, orgID, func(tx pgx.Tx) error {
		_, err := New(tx).GetPatient(ctx, GetPatientParams{ID: created.ID, OrganizationID: org})
		return err
	}); err == nil {
		t.Fatal("get after delete returned a row, want pgx.ErrNoRows")
	}
}
