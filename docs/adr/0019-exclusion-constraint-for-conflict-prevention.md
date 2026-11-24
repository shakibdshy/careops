# Conflict prevention by a database exclusion constraint

In the Go replica, double-booking is prevented by a **PostgreSQL exclusion
constraint**: on the appointments table, the range `[start, start + duration)`
for a Provider excludes overlaps with other rows whose status is
slot-holding — the same positive status set the shared lifecycle module
defines (ADR-0010's `$nin` predicate, mirrored through the contract). The
app-level conflict check remains (for the 409 response body and for
reschedule validation), but the _guarantee_ lives in the database: two
conflicting bookings arriving concurrently cannot both commit, no matter
what the application does.

This extends ADR-0010 rather than replacing it. The reference API enforces
the same rule transactionally (conflict read + create inside one Mongo
transaction with retry semantics). The Postgres constraint makes the rule a
property of the data: `EXCLUDE USING gist` over a range type with the status
condition compiled in. A constraint violation maps to the same 409 response
the reference returns, through the same error taxonomy.

## Considered Options

- **Transactional check-then-insert only** (the Mongo pattern ported to
  SQL) — works under the default read-committed isolation only if the check
  locks conflicting rows (`SELECT ... FOR UPDATE`) or the transaction runs
  serializable; both are easy to get subtly wrong under load, and a retry
  loop re-enters application code. Rejected as the sole guard; kept for the
  response shape.
- **Advisory locks per provider** — application-managed correctness again:
  every code path that inserts appointments must remember to lock, and
  nothing in the schema states the rule. Rejected.
- **Trigger-based validation** — a constraint expressed as imperative code
  with the same race surface as the check-then-insert it replaces. Rejected;
  the declarative form is the point.

## Consequences

- The slot-holding status set must stay in sync with the shared lifecycle
  vocabulary (it is generated from the contract, drift-checked like every
  other contract consumer — ADR-0015).
- Range arithmetic needs the appointment's start and duration in one place:
  the constraint uses a `tstzrange` column maintained alongside the plain
  columns (a generated column, so it cannot drift from them).
- Reschedule is an update of the same constrained columns, so the rule
  covers moves for free — including the reference-verified rule that a
  reschedule can conflict with itself only if it truly overlaps.
- Concurrency is tested at the database-level seam: many conflicting inserts
  in parallel produce exactly one appointment and 409s for the rest.
