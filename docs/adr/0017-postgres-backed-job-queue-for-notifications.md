# Notifications and Reminders on a PostgreSQL-backed queue

The Go replica's asynchronous work — Notification delivery and Reminder
scheduling/withdrawal — runs on a **PostgreSQL-backed job queue** in the same
database as the domain data, not on Redis. A job is enqueued **in the same
transaction** as the domain change that causes it (a booking commit enqueues
the confirmation and schedules the Reminder atomically with the booking).
Workers run inside the service process and are safe on multiple replicas.

The semantics carried over from the NestJS side are the contract, not the
mechanism: durable receipts with a unique (Organization, type, referenced
record) constraint giving at-most-one delivery per event; outcomes SENT /
FAILED / SKIPPED (no Contact Email) — never a silent drop; Reminders
scheduled 24h ahead and withdrawn when the Appointment is cancelled or moved;
recipient resolved at delivery time. Processing is at-least-once with
retries, and the unique receipt makes redelivery a no-op at the storage
layer, exactly as the Mongo-side dedup does today.

## Considered Options

- **Reuse BullMQ (Redis) from Go** — keeps one queue tech, but Go's BullMQ
  support is community-only, and the replica's headline guarantee — job
  enqueued transactionally with the booking — is exactly what Redis-backed
  queues _cannot_ provide (Redis writes are not part of the Mongo
  transaction; the reference side lives with that gap, noted in its
  notification docs). Postgres-backed queues exist precisely for this. The
  mechanism difference is also the point: it is one of the guarantees
  PostgreSQL solves a second, stronger way (see ADR-0014).
- **In-process timers without a queue** — loses durability across deploys and
  crashes; a reminder that matters must survive a rolling deploy. Rejected.
- **A separate worker deployment** — a second service to operate for work
  that is inherently the same domain as the API's own writes. The spec keeps
  workers in-process; extraction remains possible later because the queue is
  durable.

## Consequences

- Skipped/failed jobs are observable as receipts, and a crash between domain
  commit and enqueue is impossible by construction — the gap that needs a
  best-effort bump elsewhere does not exist here.
- The jobs tables need maintenance discipline (completed-job pruning) and an
  index per poller query shape; both are part of the schema, like any other
  table.
- Redis is still used by the Go service — for the reports cache only
  (ADR-0011's generation-counter strategy carries over).
