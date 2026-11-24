# Row-level security as the second tenancy guard (PostgreSQL)

Organization isolation in the Go replica is enforced **twice**: every
Organization-scoped query filters by the caller's Organization id (the same
app-level discipline as the NestJS repository base, ADR-0006), **and**
PostgreSQL row-level security policies — keyed by a per-request Organization
setting on the connection — reject any row outside that Organization even if
a query forgets to filter. RLS is a property of the database session, so an
unscoped connection cannot read or write another Organization's rows.

The scope is deliberately narrow: only Organization-scoped _domain_ tables
(patients, appointments, audit entries, notifications, their receipts). The
identity plane is excluded by design — user lookup by email must be global
(the invitation flow and BetterAuth-compatible sign-in both resolve users
before any Organization context exists) — and that exception is named here
rather than smuggled: the auth tables are guarded by their own constraint
set (unique email) and are never exposed through Organization-scoped routes.

## Considered Options

- **Application-scoped queries only** (the Mongo pattern verbatim) — the
  compile-time-enforced repository base is strong, but the second
  implementation exists to show what SQL gives; RLS converts "a missed
  filter is a bug we hope tests catch" into "a missed filter is a denied
  query". Rejected as the only layer; kept as the first layer.
- **Database-per-tenant** — isolation is total, but the operational model
  (migrations per tenant, connection pooling, the demo's multi-tenant
  dataset) collapses, and it contradicts the discriminator-key decision the
  whole project is built on (ADR-0006). Rejected.
- **Postgres schemas per tenant (search_path)** — same operational collapse
  with weaker tooling support. Rejected.

## Consequences

- Every request must set the Organization context on its connection before
  querying (`SET LOCAL` inside the request's transaction), and every
  connection from a pool must reset it — a per-request middleware concern,
  tested at the database-level seam (a mis-scoped query must fail, not
  filter).
- Policies add negligible read cost (the policy predicate composes with the
  query's own filter) but must be created for every new domain table — part
  of the migration checklist.
- Testing: the narrow database-level seam proves both directions — RLS
  denies cross-Organization reads/writes, and the app-level filter still
  scopes every query so plans stay index-shaped.
