# Audit Entries commit in the same transaction as the mutation

Every mutation in the Go replica writes its Audit Entry — who, what, when,
before→after — **inside the same PostgreSQL transaction** as the mutation
itself. The reference API already treats Audit Entries as append-only,
atomic before-snapshot-on-update records (its audit docs); the Go side keeps
those semantics and tightens one edge: the same-transaction guarantee is
absolute, because the database allows it without a second coordinated write.
No code path can commit a mutation whose Audit Entry is missing, and no
Audit Entry can exist for a mutation that rolled back.

Append-only is enforced by the database, not conventions: no UPDATE or
DELETE grant exists for the audit table in the application role, and the
migration states the rule as a policy — the strongest available expression
of "never edited or deleted" (the glossary's Audit Entry rule).

## Considered Options

- **Post-commit write** (one transaction for the mutation, a second for the
  audit) — the shape the Mongo side effectively has, and the reason the
  architecture audit flagged the reference's audit as not failure-safe: a
  crash between the two writes loses the audit trail for a committed
  mutation, silently. Rejected — Postgres makes the gap avoidable, so it is
  avoided.
- **Outbox pattern for audit** — solves the same problem for _cross-service_
  effects; the audit read model lives in the same database, so a second
  table plus a relay would be mechanism without benefit here. The outbox
  shape is used where it _does_ belong: the notification queue (ADR-0017).
- **Application-enforced append-only** (no update/delete paths in code) —
  the reference's approach; kept for the API surface, but the database-level
  denial is what makes it structural.

## Consequences

- Writes get marginally heavier (one more row per transaction, in the same
  commit) — the same cost the reference pays across two, now paid once with
  a stronger guarantee.
- Updates capture the before→after snapshot from the rows already loaded in
  the transaction; no extra read is needed.
- The audit table grows unbounded by design; its indexes (list-by-org by
  cursor, ADR-0008's keyset shape) are part of the migration, and its
  write-only nature keeps them cheap.
