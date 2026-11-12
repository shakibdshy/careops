# Transactional Conflict prevention for bookings

A booking's Conflict check and insert run inside one MongoDB transaction, and every
booking transaction first writes a `provider_schedule` document — one per
{Organization, Provider}. Snapshot isolation alone cannot prevent double-booking: two
transactions that each read a free slot and insert _different_ Appointment documents
never conflict (write skew). The schedule write is a deliberate serialization point:
concurrent bookings of the same Provider collide on that one document, one transaction
aborts with a transient error, and the driver's retry re-runs it against the winner's
snapshot — where the overlap check now sees the winning Appointment and rejects with 409. Transactions require a replica set, so dev compose runs a single-node replica set
and e2e boots `MongoMemoryReplSet`.

## Considered Options

- **Check-then-insert without a transaction** — the obvious read-then-write; two
  concurrent bookings both pass the check and both persist. Rejected.
- **Document-level locking** — MongoDB has no pessimistic row locks; an application
  lock document with expiry adds crash/leak failure modes and a second concurrency
  protocol to get right. Rejected in favor of the database's own write-write conflict
  detection.
- **Unique-index tricks** — a unique index enforces equality (one booking per exact
  slot key) but cannot express interval overlap of `[start, start+duration)`; fixed
  bucket keys either miss overlaps across buckets or forbid legitimate back-to-back
  bookings. Rejected.

## Consequences

- Every booking pays one extra write; the schedule row is intentionally a hot document
  per Provider — that contention _is_ the mutex.
- Transient-retry exhaustion (no application error) surfaces as a retryable 409, never
  a partial booking.
- Replica-set topology is a hard requirement in every environment (dev, e2e,
  production); a standalone mongod refuses the booking path outright.
