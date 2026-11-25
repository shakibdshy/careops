# PostgreSQL for the Go replica — separate databases per backend

The Go service owns its **own PostgreSQL schema**; the NestJS API keeps
MongoDB (ADR-0003). The two backends share no data and no sessions: both load
the same demo seed, and switching backends means signing in again on the other
host. The separation is structural, not a shared-database convention with
discipline rules.

The driver is the same portfolio goal as ADR-0013, pointed at the second gap:
the roles this project targets ask for **SQL/PostgreSQL**, and a Go service on
MongoDB would demonstrate the language while leaving the database column of
the checklist empty. The replica framing turns the second database into more
than a checkbox: every storage-side guarantee gets solved a second way, with
the trade-offs side by side — tenant isolation via row-level security instead
of a discriminator base class (ADR-0018), conflict prevention via an exclusion
constraint instead of a transaction with a read (ADR-0019), keyset pagination
in SQL instead of Mongo sort-range cursors (ADR-0008).

## Considered Options

- **Shared MongoDB cluster, separate collections** — no re-implementation of
  storage concerns at all (the Go service would import the same document
  shapes), which is exactly why it was rejected: it proves neither Go's
  database ecosystem nor SQL, and it couples the two services at the storage
  layer — the worst of both worlds for the stated goal.
- **Shared MongoDB, Go's own database in the same deployment** — keeps ops
  simple, same rejection: the Go side would speak BSON, not SQL.
- **A second Mongo deployment for Go** — same as above with extra ops cost.

## Consequences

- **No cross-backend consistency.** A booking made on one backend is
  invisible on the other. Accepted: the deployment model is "pick a backend
  per origin", not "both backends on one live data set" (ADR-0016). The
  comparison story (conformance suite, load receipts) requires identical
  _seeded_ state, which the seed command provides.
- **Duplicated demo data.** Two seeds must stay in sync by content. The
  parity ticket asserts the same key counts and fields across both.
- Postgres-specific work is required and deliberate: typed SQL (compile-time
  checked queries), versioned forward-only migrations run as a deploy step,
  and connection pooling sized for the Fargate replica count.
