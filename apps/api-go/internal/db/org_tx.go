package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// OrgTx runs fn inside one transaction whose `app.organization_id` setting
// is pinned to organizationID. Every Organization-scoped query must run in
// this scope: the row-level security policies (ADR-0018) key on the setting,
// so a query that forgets its WHERE clause sees nothing instead of
// everything. SET LOCAL is transaction-bound — the scope cannot leak past
// the commit/rollback.
func OrgTx(
	ctx context.Context,
	pool *pgxpool.Pool,
	organizationID string,
	fn func(pgx.Tx) error,
) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("org tx: begin: %w", err)
	}
	// The id is a UUID column value everywhere; pinning it as a parameter
	// (never string interpolation) keeps the setting injection-safe.
	if _, err := tx.Exec(ctx, `SELECT set_config('app.organization_id', $1, true)`, organizationID); err != nil {
		_ = tx.Rollback(ctx)
		return fmt.Errorf("org tx: set scope: %w", err)
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("org tx: commit: %w", err)
	}
	return nil
}
